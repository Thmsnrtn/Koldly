/**
 * Revenue Attribution Service
 *
 * Connects the dots from first email → open → reply → CRM deal → won.
 * Provides statistical analysis for A/B tests using Z-test for proportions.
 *
 * Key metrics:
 *   - Pipeline influenced (prospects replied interested → deal created)
 *   - Reply rate per campaign / subject variant / email angle
 *   - Meeting booked rate
 *   - Statistical significance for A/B experiments
 */

class AttributionService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Get the primary attribution dashboard for a user.
   * Returns pipeline influenced, reply rates, and top campaigns.
   */
  async getUserAttributionSummary(userId, days = 30) {
    const since = `NOW() - INTERVAL '${days} days'`;

    // Emails sent in window
    const sentResult = await this.pool.query(
      `SELECT COUNT(*) as sent,
              COUNT(*) FILTER (WHERE ds.open_count > 0) as opened,
              COUNT(*) FILTER (WHERE ds.click_count > 0) as clicked
       FROM email_delivery_status ds
       JOIN generated_emails ge ON ge.id = ds.generated_email_id
       JOIN campaigns c ON ge.campaign_id = c.id
       WHERE c.user_id = $1 AND ds.sent_at >= ${since}`,
      [userId]
    );

    // Replies in window
    const replyResult = await this.pool.query(
      `SELECT COUNT(*) as total_replies,
              COUNT(*) FILTER (WHERE pri.category = 'interested') as interested,
              COUNT(*) FILTER (WHERE pri.category = 'objection') as objections,
              COUNT(*) FILTER (WHERE pri.category = 'not_interested') as not_interested
       FROM prospect_reply_inbox pri
       JOIN campaigns c ON pri.campaign_id = c.id
       WHERE c.user_id = $1 AND pri.received_at >= ${since}`,
      [userId]
    );

    // CRM deals created from Koldly (via crm_sync_log)
    const dealsResult = await this.pool.query(
      `SELECT COUNT(*) as deals_created
       FROM crm_sync_log
       WHERE user_id = $1 AND synced_at >= ${since} AND action = 'interested_reply'`,
      [userId]
    );

    // Top performing campaigns
    const topCampaigns = await this.pool.query(
      `SELECT
         c.id, c.name,
         COUNT(ds.id) as emails_sent,
         COUNT(ds.id) FILTER (WHERE ds.open_count > 0) as opened,
         COUNT(pri.id) as replies,
         COUNT(pri.id) FILTER (WHERE pri.category = 'interested') as interested,
         CASE WHEN COUNT(ds.id) > 0 THEN
           ROUND((COUNT(pri.id)::numeric / COUNT(ds.id)) * 100, 1)
         ELSE 0 END as reply_rate_pct
       FROM campaigns c
       LEFT JOIN generated_emails ge ON ge.campaign_id = c.id
       LEFT JOIN email_delivery_status ds ON ds.generated_email_id = ge.id
       LEFT JOIN prospect_reply_inbox pri ON pri.campaign_id = c.id AND pri.received_at >= ${since}
       WHERE c.user_id = $1 AND c.status != 'archived'
       GROUP BY c.id, c.name
       HAVING COUNT(ds.id) > 0
       ORDER BY reply_rate_pct DESC
       LIMIT 10`,
      [userId]
    );

    const sent = sentResult.rows[0];
    const replies = replyResult.rows[0];
    const deals = dealsResult.rows[0];

    const totalSent = parseInt(sent.sent) || 0;
    const totalReplies = parseInt(replies.total_replies) || 0;
    const totalInterested = parseInt(replies.interested) || 0;

    return {
      window_days: days,
      emails_sent: totalSent,
      emails_opened: parseInt(sent.opened) || 0,
      emails_clicked: parseInt(sent.clicked) || 0,
      open_rate: totalSent > 0 ? Math.round((parseInt(sent.opened) / totalSent) * 1000) / 10 : 0,
      reply_rate: totalSent > 0 ? Math.round((totalReplies / totalSent) * 1000) / 10 : 0,
      interested_rate: totalSent > 0 ? Math.round((totalInterested / totalSent) * 1000) / 10 : 0,
      total_replies: totalReplies,
      interested_replies: totalInterested,
      objection_replies: parseInt(replies.objections) || 0,
      not_interested_replies: parseInt(replies.not_interested) || 0,
      deals_created: parseInt(deals.deals_created) || 0,
      top_campaigns: topCampaigns.rows
    };
  }

  /**
   * Get attribution for a specific campaign — tracing individual email → reply → deal.
   */
  async getCampaignAttribution(campaignId, userId) {
    // Verify ownership
    const campaign = await this.pool.query(
      'SELECT id, name FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, userId]
    );
    if (campaign.rows.length === 0) throw new Error('Campaign not found');

    const result = await this.pool.query(
      `SELECT
         p.company_name,
         p.contact_email,
         p.contact_title,
         ge.subject_line,
         ds.sent_at,
         ds.open_count,
         ds.click_count,
         ds.delivery_status,
         pri.received_at as replied_at,
         pri.category as reply_category,
         csl.crm_deal_id,
         csl.synced_at as deal_created_at,
         'email' as channel
       FROM generated_emails ge
       JOIN prospects p ON p.id = ge.prospect_id
       LEFT JOIN email_delivery_status ds ON ds.generated_email_id = ge.id
       LEFT JOIN prospect_reply_inbox pri ON pri.prospect_id = p.id AND pri.campaign_id = $1
       LEFT JOIN crm_sync_log csl ON csl.prospect_id = p.id AND csl.campaign_id = $1
       WHERE ge.campaign_id = $1
       ORDER BY ds.sent_at DESC NULLS LAST`,
      [campaignId]
    );

    // Calculate funnel metrics
    const rows = result.rows;
    const sent = rows.filter(r => r.sent_at).length;
    const opened = rows.filter(r => r.open_count > 0).length;
    const replied = rows.filter(r => r.replied_at).length;
    const interested = rows.filter(r => r.reply_category === 'interested').length;
    const deals = rows.filter(r => r.crm_deal_id).length;

    return {
      campaign: campaign.rows[0],
      funnel: {
        sent,
        opened,
        replied,
        interested,
        deals_created: deals,
        open_rate: sent > 0 ? Math.round((opened / sent) * 1000) / 10 : 0,
        reply_rate: sent > 0 ? Math.round((replied / sent) * 1000) / 10 : 0,
        conversion_rate: sent > 0 ? Math.round((deals / sent) * 1000) / 10 : 0
      },
      prospects: rows
    };
  }

  /**
   * Analyze an A/B experiment for statistical significance.
   * Uses two-proportion Z-test.
   *
   * @param {number} experimentId
   * @param {string} metric - 'open_rate' | 'reply_rate' | 'interested_rate'
   * @returns {object} { variants, winner, significant, p_value, confidence }
   */
  async analyzeExperiment(experimentId, metric = 'reply_rate') {
    const experiment = await this.pool.query(
      `SELECT * FROM ab_experiments WHERE id = $1`,
      [experimentId]
    );
    if (experiment.rows.length === 0) throw new Error('Experiment not found');

    const exp = experiment.rows[0];

    // Get assignments with outcomes
    const assignments = await this.pool.query(
      `SELECT
         aa.variant,
         COUNT(*) as sample_size,
         COUNT(ds.id) FILTER (WHERE ds.open_count > 0) as opens,
         COUNT(pri.id) as replies,
         COUNT(pri.id) FILTER (WHERE pri.category = 'interested') as interested_replies
       FROM ab_assignments aa
       LEFT JOIN generated_emails ge ON ge.id = aa.entity_id AND aa.entity_type = 'email'
       LEFT JOIN email_delivery_status ds ON ds.generated_email_id = ge.id
       LEFT JOIN prospect_reply_inbox pri ON pri.prospect_id = ge.prospect_id AND pri.campaign_id = ge.campaign_id
       WHERE aa.experiment_id = $1
       GROUP BY aa.variant`,
      [experimentId]
    );

    if (assignments.rows.length < 2) {
      return { experiment: exp, variants: assignments.rows, significant: false, message: 'Insufficient variant data' };
    }

    const variants = assignments.rows.map(row => {
      const n = parseInt(row.sample_size);
      let conversions;
      if (metric === 'open_rate') conversions = parseInt(row.opens);
      else if (metric === 'reply_rate') conversions = parseInt(row.replies);
      else conversions = parseInt(row.interested_replies);

      const rate = n > 0 ? conversions / n : 0;
      return { variant: row.variant, n, conversions, rate };
    });

    // Two-proportion Z-test (control = first variant)
    const [control, treatment] = variants;
    const { zScore, pValue } = this._twoProportionZTest(
      control.conversions, control.n,
      treatment.conversions, treatment.n
    );

    const significant = pValue < 0.05;
    const confidence = Math.min(99.9, Math.round((1 - pValue) * 1000) / 10);
    const winner = significant
      ? (treatment.rate > control.rate ? treatment.variant : control.variant)
      : null;

    return {
      experiment: { id: exp.id, name: exp.name, metric },
      variants: variants.map(v => ({
        ...v,
        rate_pct: Math.round(v.rate * 1000) / 10
      })),
      control_variant: control.variant,
      treatment_variant: treatment.variant,
      z_score: Math.round(zScore * 100) / 100,
      p_value: Math.round(pValue * 10000) / 10000,
      confidence_pct: confidence,
      significant,
      winner,
      recommendation: significant
        ? `Ship variant "${winner}" (${confidence}% confidence)`
        : `Continue test — ${Math.max(0, Math.round(200 - control.n - treatment.n))} more samples needed for significance`
    };
  }

  /**
   * Two-proportion Z-test implementation.
   * Tests H0: p1 = p2 against H1: p1 ≠ p2
   */
  _twoProportionZTest(x1, n1, x2, n2) {
    if (n1 === 0 || n2 === 0) return { zScore: 0, pValue: 1 };

    const p1 = x1 / n1;
    const p2 = x2 / n2;
    const pooled = (x1 + x2) / (n1 + n2);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));

    if (se === 0) return { zScore: 0, pValue: 1 };

    const zScore = (p2 - p1) / se;

    // Two-tailed p-value using normal CDF approximation
    const pValue = 2 * (1 - this._normalCDF(Math.abs(zScore)));

    return { zScore, pValue: Math.min(1, Math.max(0, pValue)) };
  }

  /**
   * Standard normal CDF approximation (Abramowitz & Stegun)
   */
  _normalCDF(z) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = z < 0 ? -1 : 1;
    z = Math.abs(z) / Math.sqrt(2);
    const t = 1 / (1 + p * z);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * y);
  }

  /**
   * Record a meeting booked event (triggered by Calendly webhook or manual entry).
   */
  async recordMeetingBooked(userId, prospectId, campaignId, meetingTime = null) {
    await this.pool.query(
      `INSERT INTO analytics_events (event_type, user_id, metadata)
       VALUES ('meeting_booked', $1, $2)`,
      [userId, JSON.stringify({ prospect_id: prospectId, campaign_id: campaignId, meeting_time: meetingTime })]
    );

    await this.pool.query(
      `UPDATE prospects SET status = 'meeting_booked' WHERE id = $1`,
      [prospectId]
    );
  }
}

module.exports = AttributionService;
