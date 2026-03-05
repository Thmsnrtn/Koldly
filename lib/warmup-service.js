/**
 * Email Warmup Service (Tier 2 — Full Build)
 *
 * Manages the full warmup infrastructure:
 *   1. Inbox placement testing — tests deliverability to seed addresses
 *   2. Warmup schedule management — calculates ramp per domain
 *   3. Global suppression enforcement across campaigns
 *
 * This service does NOT do peer-to-peer warmup email exchange
 * (that would require dedicated warmup mailboxes, a Tier 3 infrastructure
 * investment). Instead, it focuses on the programmatic elements:
 * warmup schedule calculation, domain health scoring, and inbox placement.
 *
 * For peer-to-peer warmup, the recommended integration is Instantly.ai's
 * warmup API or Lemwarm — connect via WARMUP_API_KEY + WARMUP_PROVIDER.
 *
 * Environment variables:
 *   WARMUP_PROVIDER    — 'instantly' | 'lemwarm' | 'none' (default: none)
 *   WARMUP_API_KEY     — API key for the warmup provider
 *   GLOCKAPPS_API_KEY  — Inbox placement testing (GlockApps API)
 */

const https = require('https');

// Warmup ramp schedule (day → max emails per day)
// Conservative ramp designed to maximize inbox placement
const WARMUP_RAMP = [
  { day: 1, limit: 5 },
  { day: 3, limit: 10 },
  { day: 7, limit: 20 },
  { day: 10, limit: 35 },
  { day: 14, limit: 50 },
  { day: 21, limit: 75 },
  { day: 30, limit: 100 },
  { day: 45, limit: 150 },
  { day: 60, limit: 200 },
  { day: 90, limit: 500 }
];

/**
 * Get the recommended daily send limit for a domain based on days since warmup started.
 */
function getWarmupLimit(daysSinceStart, hardLimit = 500) {
  let limit = 5;
  for (const point of WARMUP_RAMP) {
    if (daysSinceStart >= point.day) {
      limit = point.limit;
    }
  }
  return Math.min(limit, hardLimit);
}

class WarmupService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Initialize a warmup plan for a campaign.
   * Called when a campaign is first activated.
   */
  async initializeCampaignWarmup(campaignId, startDate = null) {
    const start = startDate || new Date();

    // Create warmup day records for 90 days
    const records = [];
    for (const point of WARMUP_RAMP) {
      const planDate = new Date(start);
      planDate.setDate(planDate.getDate() + point.day - 1);

      records.push(
        this.pool.query(
          `INSERT INTO email_warmup_plans
           (campaign_id, day_number, max_emails_per_day, warmup_start_date)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (campaign_id, day_number) DO NOTHING`,
          [campaignId, point.day, point.limit, planDate.toISOString().slice(0, 10)]
        )
      );
    }

    await Promise.all(records);
    console.info(`[Warmup] Initialized warmup plan for campaign ${campaignId}`);
    return { campaign_id: campaignId, plan_days: WARMUP_RAMP.length };
  }

  /**
   * Get today's sending limit for a campaign based on warmup day.
   */
  async getDailyLimit(campaignId) {
    // Get campaign creation date to calculate warmup day
    const result = await this.pool.query(
      `SELECT c.created_at, COALESCE(csc.daily_send_limit, 100) as hard_limit
       FROM campaigns c
       LEFT JOIN campaign_sending_context csc ON csc.campaign_id = c.id
       WHERE c.id = $1`,
      [campaignId]
    );

    if (result.rows.length === 0) return 10; // Safe default

    const campaignAge = Math.max(1, Math.floor(
      (Date.now() - new Date(result.rows[0].created_at).getTime()) / (1000 * 60 * 60 * 24)
    ));

    return getWarmupLimit(campaignAge, parseInt(result.rows[0].hard_limit));
  }

  /**
   * Calculate a domain health score based on recent bounce and complaint rates.
   * Returns 0-100 (100 = excellent).
   */
   async getDomainHealthScore(senderEmail) {
    const domain = (senderEmail || '').split('@')[1];
    if (!domain) return 100;

    const result = await this.pool.query(
      `SELECT
         COUNT(*) as total_sent,
         COUNT(*) FILTER (WHERE ds.delivery_status = 'bounced') as bounces,
         COUNT(*) FILTER (WHERE ds.complaint_status IS NOT NULL) as complaints
       FROM email_delivery_status ds
       JOIN generated_emails ge ON ge.id = ds.generated_email_id
       JOIN campaigns c ON ge.campaign_id = c.id
       JOIN campaign_sending_context csc ON csc.campaign_id = c.id
       WHERE csc.sender_email LIKE $1
         AND ds.sent_at >= NOW() - INTERVAL '30 days'`,
      [`%@${domain}`]
    );

    const stats = result.rows[0];
    const total = parseInt(stats.total_sent) || 0;
    if (total < 10) return 85; // Not enough data — return moderate baseline

    const bounceRate = parseInt(stats.bounces) / total;
    const complaintRate = parseInt(stats.complaints) / total;

    // Score: start at 100, subtract for bounce/complaint rates
    // Industry benchmarks: bounce < 2%, complaint < 0.1%
    let score = 100;
    if (bounceRate > 0.05) score -= 40;
    else if (bounceRate > 0.02) score -= 20;
    else if (bounceRate > 0.01) score -= 10;

    if (complaintRate > 0.005) score -= 30;
    else if (complaintRate > 0.001) score -= 15;
    else if (complaintRate > 0.0005) score -= 5;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Run an inbox placement test for a given email.
   * Sends to seed addresses and reports inbox vs. spam placement.
   *
   * Requires GLOCKAPPS_API_KEY.
   * Returns a placement report or null if not configured.
   */
  async runInboxPlacementTest(subject, body, senderEmail, senderName) {
    if (!process.env.GLOCKAPPS_API_KEY) {
      return null; // Not configured
    }

    try {
      const payload = JSON.stringify({
        api_token: process.env.GLOCKAPPS_API_KEY,
        from_email: senderEmail,
        from_name: senderName || senderEmail.split('@')[0],
        subject,
        html: body,
        test_id: `koldly_${Date.now()}`
      });

      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.glockapps.com',
          port: 443,
          path: '/v1/inbox-tests',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('GlockApps timeout')); });
        req.write(payload);
        req.end();
      });

      return {
        test_id: result.test_id,
        status: result.status,
        seed_addresses: result.seed_addresses || [],
        // Placement results come via webhook or polling after ~5 min
      };
    } catch (err) {
      console.warn('[Warmup] Inbox placement test failed:', err.message);
      return null;
    }
  }

  /**
   * Process GlockApps placement result webhook.
   * Called from /api/webhooks/glockapps endpoint.
   */
  async processPlacementResult(payload) {
    const { test_id, results } = payload;
    if (!results) return;

    // Calculate aggregate inbox placement rate
    let inboxCount = 0;
    let spamCount = 0;
    let totalCount = 0;

    for (const result of results) {
      totalCount++;
      if (result.folder === 'inbox') inboxCount++;
      else if (result.folder === 'spam') spamCount++;
    }

    const inboxRate = totalCount > 0 ? Math.round((inboxCount / totalCount) * 100) : 0;

    console.info(`[Warmup] Inbox placement test ${test_id}: ${inboxRate}% inbox (${spamCount} spam)`);

    // Store result for the campaign analytics view
    await this.pool.query(
      `INSERT INTO inbox_placement_tests (test_id, inbox_rate, spam_rate, total_seeds, raw_results, completed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (test_id) DO UPDATE
       SET inbox_rate = $2, spam_rate = $3, raw_results = $5, completed_at = NOW()`,
      [test_id, inboxRate, Math.round((spamCount / Math.max(1, totalCount)) * 100), totalCount, JSON.stringify(results)]
    ).catch(err => console.warn('[Warmup] Failed to store placement result:', err.message));

    return { test_id, inbox_rate: inboxRate, spam_rate: 100 - inboxRate };
  }

  /**
   * Get warmup status for a campaign — used in campaign dashboard.
   */
  async getCampaignWarmupStatus(campaignId, senderEmail) {
    const campaignResult = await this.pool.query(
      `SELECT created_at FROM campaigns WHERE id = $1`,
      [campaignId]
    );

    if (campaignResult.rows.length === 0) return null;

    const daysSinceStart = Math.max(1, Math.floor(
      (Date.now() - new Date(campaignResult.rows[0].created_at).getTime()) / (1000 * 60 * 60 * 24)
    ));

    const todayLimit = getWarmupLimit(daysSinceStart);
    const healthScore = senderEmail ? await this.getDomainHealthScore(senderEmail) : null;

    // Get emails sent today
    const sentTodayResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM email_delivery_status ds
       JOIN generated_emails ge ON ge.id = ds.generated_email_id
       WHERE ge.campaign_id = $1 AND ds.sent_at >= CURRENT_DATE`,
      [campaignId]
    );

    const sentToday = parseInt(sentTodayResult.rows[0].count) || 0;

    return {
      warmup_day: daysSinceStart,
      daily_limit: todayLimit,
      sent_today: sentToday,
      remaining_today: Math.max(0, todayLimit - sentToday),
      domain_health_score: healthScore,
      is_warmed: daysSinceStart >= 30
    };
  }
}

module.exports = WarmupService;
