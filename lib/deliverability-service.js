/**
 * Deliverability Service
 *
 * Activates the 6-table deliverability schema that exists in migrations but
 * previously had no service logic. Provides three integration points:
 *
 *   1. checkSpam(emailId, subject, body)       — pre-send spam scoring
 *   2. enforceWarmupLimits(campaignId)         — daily volume cap from warmup plan
 *   3. recordOutcome(emailId, email, result)   — post-send delivery status tracking
 *
 * Also handles inbound bounce/complaint webhooks from Mailgun and SES.
 */

// Spam trigger words and patterns that commonly cause filtering
const SPAM_TRIGGERS = [
  // Urgency / pressure words
  'act now', 'act immediately', 'limited time', 'expires soon', 'urgent',
  'don\'t miss out', 'last chance', 'final notice', 'respond immediately',
  // Money / financial
  'earn money', 'make money', 'extra income', 'no cost', 'free offer',
  'cash bonus', 'winner', 'prize', 'congratulations', 'selected',
  // Spam phrases
  'click here', 'buy now', 'order now', 'call now', 'subscribe now',
  'unsubscribe', 'opt out', 'remove me', 'million dollars',
  'guaranteed', '100% free', 'absolutely free', 'no obligation',
  'risk-free', 'no hidden fees', 'no strings attached',
  // Phishing indicators
  'verify your account', 'confirm your', 'update your information',
  'your account has been', 'billing information',
  // Excessive punctuation patterns (checked separately)
];

const SPAM_SUBJECT_TRIGGERS = [
  'fw:', 'fwd:', 're: re:', '[urgent]', 'important notice',
  'account suspended', 'account cancelled', 'verify now',
];

/**
 * Score a subject line and email body for spam likelihood.
 * Returns a score from 0 (clean) to 10 (definitely spam).
 */
function calculateSpamScore(subject, body) {
  let score = 0;
  const flags = [];

  const subjectLower = (subject || '').toLowerCase();
  const bodyLower = (body || '').toLowerCase();
  const combined = `${subjectLower} ${bodyLower}`;
  const fullText = `${subject || ''} ${body || ''}`;

  // Check subject-specific triggers (higher weight)
  for (const trigger of SPAM_SUBJECT_TRIGGERS) {
    if (subjectLower.includes(trigger)) {
      score += 1.5;
      flags.push(`subject:${trigger}`);
    }
  }

  // Check body triggers
  for (const trigger of SPAM_TRIGGERS) {
    if (combined.includes(trigger)) {
      score += 0.5;
      flags.push(trigger);
    }
  }

  // Excessive caps check (> 30% of letters are uppercase)
  const letters = fullText.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 20) {
    const capsRatio = (fullText.replace(/[^A-Z]/g, '').length) / letters.length;
    if (capsRatio > 0.4) {
      score += 2;
      flags.push('excessive_caps');
    } else if (capsRatio > 0.25) {
      score += 1;
      flags.push('high_caps');
    }
  }

  // All-caps subject line
  if (subject && subject === subject.toUpperCase() && subject.length > 5) {
    score += 1.5;
    flags.push('all_caps_subject');
  }

  // Excessive exclamation marks
  const exclamationCount = (fullText.match(/!/g) || []).length;
  if (exclamationCount > 3) {
    score += Math.min(2, (exclamationCount - 3) * 0.5);
    flags.push(`exclamation_overuse:${exclamationCount}`);
  }

  // Very short or very long subject
  if (subject) {
    if (subject.length < 5) { score += 0.5; flags.push('subject_too_short'); }
    if (subject.length > 80) { score += 0.5; flags.push('subject_too_long'); }
  }

  // No personalization (pure template signal)
  if (body && !body.includes('{{') && bodyLower.length > 200) {
    // This is fine — just noting it's not template-based
  }

  // Excessive links
  const linkCount = (body || '').match(/https?:\/\//g);
  if (linkCount && linkCount.length > 4) {
    score += 1;
    flags.push(`too_many_links:${linkCount.length}`);
  }

  return {
    score: Math.min(10, Math.round(score * 10) / 10),
    flags,
    recommendation: score >= 7.5 ? 'block' : score >= 5 ? 'warn' : 'pass'
  };
}

class DeliverabilityService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Run a spam check on an email before it enters the approval queue.
   * Writes result to email_spam_checks table.
   *
   * @returns {object} { score, flags, recommendation, id }
   *   recommendation: 'pass' | 'warn' | 'block'
   */
  async checkSpam(generatedEmailId, subject, body) {
    const result = calculateSpamScore(subject, body);

    try {
      const flagsText = result.flags.join(', ') || null;
      const insertResult = await this.pool.query(
        `INSERT INTO email_spam_checks
         (generated_email_id, subject_line, email_body, spam_score, flagged_keywords, recommendation)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [generatedEmailId, subject, body && body.slice(0, 2000), result.score, flagsText, result.recommendation]
      );
      result.check_id = insertResult.rows[0].id;
    } catch (err) {
      // Non-blocking — spam check records are informational
      console.warn('[Deliverability] Failed to persist spam check:', err.message);
    }

    return result;
  }

  /**
   * Enforce warmup limits for a campaign.
   * Returns how many more emails can be sent today.
   *
   * On a campaign's first day, initializes a 30-day warmup plan.
   * Warmup ramp: day 1=10, day 2=20, day 3=30 ... capped at campaign daily_send_limit.
   *
   * @returns {number} remaining sends allowed today (0 = at limit)
   */
  async getRemainingDailyCapacity(campaignId) {
    try {
      // Get current warmup state for today
      const today = new Date().toISOString().slice(0, 10);

      const result = await this.pool.query(
        `SELECT w.*, csc.daily_send_limit
         FROM email_warmup_plans w
         JOIN campaign_sending_context csc ON csc.campaign_id = w.campaign_id
         WHERE w.campaign_id = $1
         AND w.warmup_start_date = CURRENT_DATE
         ORDER BY w.day_number ASC
         LIMIT 1`,
        [campaignId]
      );

      if (result.rows.length === 0) {
        // First time — initialize warmup plan for today
        await this._initWarmupDay(campaignId);
        return await this.getRemainingDailyCapacity(campaignId);
      }

      const plan = result.rows[0];
      const remaining = plan.max_emails_per_day - plan.current_emails_sent_today;
      return Math.max(0, remaining);
    } catch (err) {
      console.warn('[Deliverability] Warmup check failed, allowing send:', err.message);
      return Infinity; // Fail open to avoid blocking sends on deliverability errors
    }
  }

  /**
   * Increment today's warmup counter after a successful send.
   */
  async recordWarmupSend(campaignId) {
    try {
      await this.pool.query(
        `UPDATE email_warmup_plans
         SET current_emails_sent_today = current_emails_sent_today + 1, updated_at = NOW()
         WHERE campaign_id = $1 AND warmup_start_date = CURRENT_DATE`,
        [campaignId]
      );
    } catch (err) {
      console.warn('[Deliverability] Warmup counter update failed:', err.message);
    }
  }

  /**
   * Record the outcome of a send attempt.
   * Creates or updates the email_delivery_status row.
   */
  async recordOutcome(generatedEmailId, recipientEmail, result) {
    try {
      const status = result.success ? 'delivered' : 'failed';
      const externalId = result.messageId || result.message_id || null;

      await this.pool.query(
        `INSERT INTO email_delivery_status
         (generated_email_id, recipient_email, delivery_status, delivery_timestamp, message_id, external_message_id, sent_at)
         VALUES ($1, $2, $3, NOW(), $4, $4, NOW())
         ON CONFLICT (generated_email_id) DO UPDATE
         SET delivery_status = $3, delivery_timestamp = NOW(), external_message_id = $4, updated_at = NOW()`,
        [generatedEmailId, recipientEmail, status, externalId]
      );
    } catch (err) {
      console.warn('[Deliverability] Failed to record send outcome:', err.message);
    }
  }

  /**
   * Process a bounce event from Mailgun or SES webhook.
   * Updates email_bounces and email_recipient_status tables.
   *
   * @param {object} event - Normalized bounce event
   *   { recipientEmail, bounceType, bounceReason, generatedEmailId, rawPayload }
   */
  async processBounceEvent(event) {
    const { recipientEmail, bounceType, bounceReason, generatedEmailId, rawPayload } = event;

    // Insert bounce record
    if (generatedEmailId) {
      try {
        await this.pool.query(
          `INSERT INTO email_bounces
           (generated_email_id, recipient_email, bounce_type, bounce_reason, bounce_details)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            generatedEmailId,
            recipientEmail,
            bounceType || 'unknown',
            bounceReason || null,
            rawPayload ? JSON.stringify(rawPayload) : null
          ]
        );
      } catch (err) {
        console.warn('[Deliverability] Failed to insert bounce record:', err.message);
      }
    }

    // Update delivery status
    if (generatedEmailId) {
      try {
        await this.pool.query(
          `UPDATE email_delivery_status
           SET delivery_status = 'bounced', bounce_status = $1, bounce_timestamp = NOW(), updated_at = NOW()
           WHERE generated_email_id = $2`,
          [bounceType || 'hard', generatedEmailId]
        );
      } catch (err) {
        console.warn('[Deliverability] Failed to update delivery status for bounce:', err.message);
      }
    }

    // Increment bounce counter on recipient status (suppress future sends if hard bounce)
    try {
      await this.pool.query(
        `INSERT INTO email_recipient_status (recipient_email, bounce_count, status, last_checked)
         VALUES ($1, 1, $2, NOW())
         ON CONFLICT (recipient_email) DO UPDATE
         SET bounce_count = email_recipient_status.bounce_count + 1,
             status = CASE WHEN $2 = 'hard' THEN 'invalid' ELSE email_recipient_status.status END,
             last_checked = NOW()`,
        [recipientEmail, bounceType || 'soft']
      );
    } catch (err) {
      // email_recipient_status may have a different unique constraint — log and continue
      console.warn('[Deliverability] Failed to update recipient status for bounce:', err.message);
    }

    console.info(`[Deliverability] Bounce recorded: ${recipientEmail} (${bounceType || 'unknown'})`);
  }

  /**
   * Process a complaint/spam report event.
   */
  async processComplaintEvent(event) {
    const { recipientEmail, generatedEmailId, rawPayload } = event;

    if (generatedEmailId) {
      try {
        await this.pool.query(
          `UPDATE email_delivery_status
           SET complaint_status = 'spam_complaint', complaint_timestamp = NOW(), updated_at = NOW()
           WHERE generated_email_id = $1`,
          [generatedEmailId]
        );
      } catch (err) {
        console.warn('[Deliverability] Failed to record complaint:', err.message);
      }
    }

    // Suppress future sends to this address
    try {
      await this.pool.query(
        `INSERT INTO email_recipient_status (recipient_email, complaint_count, status, last_checked)
         VALUES ($1, 1, 'unsubscribed', NOW())
         ON CONFLICT (recipient_email) DO UPDATE
         SET complaint_count = email_recipient_status.complaint_count + 1,
             status = 'unsubscribed',
             last_checked = NOW()`,
        [recipientEmail]
      );
    } catch (err) {
      console.warn('[Deliverability] Failed to update recipient status for complaint:', err.message);
    }

    console.info(`[Deliverability] Complaint recorded: ${recipientEmail}`);
  }

  /**
   * Process a tracking pixel open event from ESP.
   */
  async recordOpen(generatedEmailId) {
    try {
      await this.pool.query(
        `UPDATE email_delivery_status
         SET open_count = open_count + 1,
             first_opened_at = COALESCE(first_opened_at, NOW()),
             last_opened_at = NOW(),
             updated_at = NOW()
         WHERE generated_email_id = $1`,
        [generatedEmailId]
      );
    } catch (err) {
      console.warn('[Deliverability] Failed to record open:', err.message);
    }
  }

  /**
   * Process a link click event from ESP.
   */
  async recordClick(generatedEmailId) {
    try {
      await this.pool.query(
        `UPDATE email_delivery_status
         SET click_count = click_count + 1,
             first_clicked_at = COALESCE(first_clicked_at, NOW()),
             last_clicked_at = NOW(),
             updated_at = NOW()
         WHERE generated_email_id = $1`,
        [generatedEmailId]
      );
    } catch (err) {
      console.warn('[Deliverability] Failed to record click:', err.message);
    }
  }

  /**
   * Check if a recipient is suppressed (bounced hard or complained).
   * Call this before queueing any email to that address.
   */
  async isSuppressed(email) {
    try {
      const result = await this.pool.query(
        `SELECT status FROM email_recipient_status
         WHERE recipient_email = $1 AND status IN ('invalid', 'unsubscribed')
         LIMIT 1`,
        [email]
      );
      return result.rows.length > 0;
    } catch (err) {
      console.warn('[Deliverability] Suppression check failed:', err.message);
      return false; // Fail open
    }
  }

  /**
   * Get deliverability summary for a campaign.
   * Used in analytics and the pre-launch campaign checklist.
   */
  async getCampaignDeliverabilityStats(campaignId) {
    try {
      const result = await this.pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE ds.delivery_status = 'delivered') as delivered,
          COUNT(*) FILTER (WHERE ds.delivery_status = 'bounced') as bounced,
          COUNT(*) FILTER (WHERE ds.delivery_status = 'failed') as failed,
          COUNT(*) FILTER (WHERE ds.open_count > 0) as opened,
          COUNT(*) FILTER (WHERE ds.click_count > 0) as clicked,
          ROUND(AVG(sc.spam_score)::numeric, 2) as avg_spam_score
         FROM generated_emails ge
         LEFT JOIN email_delivery_status ds ON ds.generated_email_id = ge.id
         LEFT JOIN email_spam_checks sc ON sc.generated_email_id = ge.id
         WHERE ge.campaign_id = $1`,
        [campaignId]
      );

      return result.rows[0] || {};
    } catch (err) {
      console.warn('[Deliverability] Stats query failed:', err.message);
      return {};
    }
  }

  // ---- Internal helpers ----

  async _initWarmupDay(campaignId) {
    try {
      // Get current day number (how many days since campaign started)
      const campaignResult = await this.pool.query(
        `SELECT created_at, daily_send_limit
         FROM campaigns c
         LEFT JOIN campaign_sending_context csc ON csc.campaign_id = c.id
         WHERE c.id = $1`,
        [campaignId]
      );

      if (campaignResult.rows.length === 0) return;
      const campaign = campaignResult.rows[0];

      const daysSinceStart = Math.max(1,
        Math.floor((Date.now() - new Date(campaign.created_at).getTime()) / (1000 * 60 * 60 * 24)) + 1
      );

      // Warmup ramp: starts at 10, increases by 10 per day, capped at daily_send_limit
      const dailyLimit = campaign.daily_send_limit || 100;
      const warmupMax = Math.min(dailyLimit, daysSinceStart * 10);

      await this.pool.query(
        `INSERT INTO email_warmup_plans
         (campaign_id, day_number, max_emails_per_day, current_emails_sent_today, warmup_start_date)
         VALUES ($1, $2, $3, 0, CURRENT_DATE)
         ON CONFLICT (campaign_id, day_number) DO NOTHING`,
        [campaignId, daysSinceStart, warmupMax]
      );
    } catch (err) {
      console.warn('[Deliverability] Warmup init failed:', err.message);
    }
  }
}

module.exports = DeliverabilityService;
