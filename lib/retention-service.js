/**
 * Retention Service
 *
 * Handles engagement scoring, churn prediction, and automated retention actions.
 * Runs daily via scheduler. All actions flow through the Decision Queue safety gates.
 */

const AIService = require('./ai-service');
const DecisionQueueService = require('./decision-queue-service');

class RetentionService {
  constructor(pool) {
    this.pool = pool;
    this.ai = new AIService(pool);
    this.decisionQueue = new DecisionQueueService(pool);
  }

  // ============================================
  // ENGAGEMENT SCORING
  // ============================================

  /**
   * Calculate engagement score for a single user (0-100)
   * Components: login_frequency (0-25), approval_rate (0-25),
   *             campaign_activity (0-25), reply_engagement (0-25)
   */
  async calculateEngagementScore(userId) {
    const components = {
      login_frequency: 0,
      approval_rate: 0,
      campaign_activity: 0,
      reply_engagement: 0
    };

    // Login frequency (last 7 days) — max 25
    const logins = await this.pool.query(
      "SELECT COUNT(*) as count FROM analytics_events WHERE user_id = $1 AND event_type = 'login' AND created_at >= NOW() - INTERVAL '7 days'",
      [userId]
    );
    const loginCount = parseInt(logins.rows[0].count);
    components.login_frequency = Math.min(25, Math.round(loginCount / 7 * 25)); // 1+ login/day = 25

    // Approval rate (emails approved / total reviewed, last 30d) — max 25
    const approvals = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'email_approved') as approved,
        COUNT(*) FILTER (WHERE event_type = 'email_edited_approved') as edited,
        COUNT(*) FILTER (WHERE event_type = 'email_rejected') as rejected
      FROM analytics_events
      WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
    `, [userId]);
    const a = approvals.rows[0];
    const totalReviewed = parseInt(a.approved) + parseInt(a.edited) + parseInt(a.rejected);
    if (totalReviewed > 0) {
      const rate = (parseInt(a.approved) + parseInt(a.edited)) / totalReviewed;
      components.approval_rate = Math.round(rate * 25);
    }

    // Campaign activity — max 25
    const campaigns = await this.pool.query(
      "SELECT COUNT(*) as count FROM campaigns WHERE user_id = $1 AND status = 'active' AND (is_archived = false OR is_archived IS NULL)",
      [userId]
    );
    const activeCampaigns = parseInt(campaigns.rows[0].count);
    components.campaign_activity = Math.min(25, activeCampaigns * 8); // 3+ active campaigns = 25

    // Reply engagement (replied to / total replies received, last 30d) — max 25
    const replies = await this.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM prospect_reply_inbox pri
         JOIN campaigns c ON pri.campaign_id = c.id
         WHERE c.user_id = $1 AND pri.received_at >= NOW() - INTERVAL '30 days') as total_replies,
        (SELECT COUNT(*) FROM reply_drafts rd
         JOIN campaigns c ON rd.campaign_id = c.id
         WHERE c.user_id = $1 AND rd.status = 'approved' AND rd.created_at >= NOW() - INTERVAL '30 days') as responded
    `, [userId]);
    const r = replies.rows[0];
    const totalReplies = parseInt(r.total_replies);
    if (totalReplies > 0) {
      const respondRate = parseInt(r.responded) / totalReplies;
      components.reply_engagement = Math.round(respondRate * 25);
    }

    const score = components.login_frequency + components.approval_rate +
                  components.campaign_activity + components.reply_engagement;
    const churnRisk = this.classifyChurnRisk(score);

    // Upsert engagement score
    await this.pool.query(`
      INSERT INTO engagement_scores (user_id, score, components, churn_risk, last_calculated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        score = $2, components = $3, churn_risk = $4, last_calculated_at = NOW()
    `, [userId, score, JSON.stringify(components), churnRisk]);

    return { userId, score, components, churnRisk };
  }

  /**
   * Classify churn risk from engagement score
   */
  classifyChurnRisk(score) {
    if (score < 20) return 'critical';
    if (score < 40) return 'high';
    if (score < 65) return 'medium';
    return 'low';
  }

  /**
   * Batch process all active users for engagement scoring
   */
  async runEngagementScoring() {
    console.log('[Retention] Running engagement scoring');
    const users = await this.pool.query(
      "SELECT id FROM users WHERE onboarding_completed = true AND created_at <= NOW() - INTERVAL '1 day'"
    );

    let processed = 0;
    for (const user of users.rows) {
      try {
        await this.calculateEngagementScore(user.id);
        processed++;
      } catch (err) {
        console.error(`[Retention] Scoring failed for user #${user.id}:`, err.message);
      }
    }

    console.log(`[Retention] Scored ${processed}/${users.rows.length} users`);
    return { processed, total: users.rows.length };
  }

  // ============================================
  // AUTOMATED RETENTION ACTIONS
  // ============================================

  /**
   * Check all users for needed retention actions
   */
  async runRetentionActions() {
    console.log('[Retention] Running retention actions');
    const results = { habit: 0, expansion: 0, churn: 0, power: 0 };

    // Get all users with engagement scores
    const users = await this.pool.query(`
      SELECT es.user_id, es.score, es.churn_risk, es.components,
             u.email, u.name, u.subscription_plan, u.activated_at
      FROM engagement_scores es
      JOIN users u ON es.user_id = u.id
      WHERE u.onboarding_completed = true
    `);

    for (const user of users.rows) {
      try {
        // Habit reinforcement for inactive users
        if (await this.checkHabitReinforcement(user)) results.habit++;
        // Expansion for users near limits
        if (await this.checkExpansionOpportunity(user)) results.expansion++;
        // Churn intervention for critical risk
        if (await this.checkChurnIntervention(user)) results.churn++;
      } catch (err) {
        console.error(`[Retention] Action check failed for user #${user.user_id}:`, err.message);
      }
    }

    // Power user identification (separate pass)
    results.power = await this.identifyPowerUsers();

    console.log(`[Retention] Actions: habit=${results.habit}, expansion=${results.expansion}, churn=${results.churn}, power=${results.power}`);
    return results;
  }

  /**
   * Habit reinforcement: nudge users who haven't logged in for 3+ days but have active campaigns
   */
  async checkHabitReinforcement(user) {
    if (user.churn_risk === 'low') return false;

    // Check last login
    const lastLogin = await this.pool.query(
      "SELECT MAX(created_at) as last_login FROM analytics_events WHERE user_id = $1 AND event_type = 'login'",
      [user.user_id]
    );
    const lastLoginDate = lastLogin.rows[0]?.last_login;
    if (!lastLoginDate) return false;

    const daysSinceLogin = (Date.now() - new Date(lastLoginDate).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLogin < 3) return false;

    // Check if we already sent a recent nudge
    if (await this._hasRecentAction(user.user_id, 'habit_reinforcement', 7)) return false;

    // Queue the nudge via Gate 1
    await this.decisionQueue.enqueue(
      `Habit nudge: ${user.email} (${Math.floor(daysSinceLogin)}d inactive)`,
      'retention', 'low', 1,
      {
        action_type: 'habit_reinforcement',
        user_id: user.user_id,
        email: user.email,
        days_inactive: Math.floor(daysSinceLogin),
        template: 'habit_nudge'
      },
      'system'
    );

    await this._recordAction(user.user_id, 'habit_reinforcement', `${Math.floor(daysSinceLogin)} days inactive`);
    return true;
  }

  /**
   * Expansion: prompt users approaching plan limits (>80% usage)
   */
  async checkExpansionOpportunity(user) {
    const plan = user.subscription_plan || 'free';
    const limits = { free: 25, starter: 100, growth: 500, scale: 2000 };
    const limit = limits[plan] || 25;
    if (plan === 'scale') return false; // Already on highest plan

    // Check prospect count this month
    const usage = await this.pool.query(`
      SELECT COUNT(*) as count FROM prospects
      WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1)
        AND created_at >= DATE_TRUNC('month', NOW())
    `, [user.user_id]);
    const used = parseInt(usage.rows[0].count);
    const usagePercent = (used / limit) * 100;

    if (usagePercent < 80) return false;

    // Check if we already sent a recent prompt
    if (await this._hasRecentAction(user.user_id, 'expansion_prompt', 14)) return false;

    await this.decisionQueue.enqueue(
      `Expansion prompt: ${user.email} (${usagePercent.toFixed(0)}% of ${plan} limits)`,
      'revenue', 'medium', 2,
      {
        action_type: 'expansion_prompt',
        user_id: user.user_id,
        email: user.email,
        current_plan: plan,
        usage_percent: usagePercent,
        template: 'upgrade_prompt'
      },
      'system'
    );

    await this._recordAction(user.user_id, 'expansion_prompt', `${usagePercent.toFixed(0)}% of ${plan} limits`);
    return true;
  }

  /**
   * Churn intervention: draft personalized win-back for critical risk users
   */
  async checkChurnIntervention(user) {
    if (user.churn_risk !== 'critical') return false;
    if (await this._hasRecentAction(user.user_id, 'win_back', 14)) return false;

    // Build context for AI
    const context = {
      name: user.name || 'there',
      email: user.email,
      plan: user.subscription_plan || 'free',
      score: user.score,
      components: typeof user.components === 'string' ? JSON.parse(user.components) : user.components,
      activated: !!user.activated_at
    };

    try {
      // Use Claude to draft a personalized win-back email
      const result = await this.ai.callJSON('churn_intervention', {
        system: `You are a customer success expert for Koldly, an AI cold email outreach SaaS. A user is at critical churn risk. Draft a personalized, empathetic win-back email.

User context: ${JSON.stringify(context)}

Return JSON: { "subject": "string", "body": "string", "internal_notes": "string" }`,
        messages: [{ role: 'user', content: `Draft a win-back email for ${context.name} (${context.email}). Their engagement score is ${context.score}/100. ${!context.activated ? 'They never activated (never approved an email).' : 'They activated but stopped engaging.'}` }]
      }, { skipCache: true });

      await this.decisionQueue.enqueue(
        `Churn intervention: ${user.email} (score: ${user.score})`,
        'retention', 'high', 2,
        {
          action_type: 'win_back',
          user_id: user.user_id,
          email: user.email,
          draft: result.content,
          template: 'churn_intervention'
        },
        'ai'
      );

      await this._recordAction(user.user_id, 'win_back', `Critical risk, score: ${user.score}`);
      return true;
    } catch (err) {
      console.error(`[Retention] Churn intervention AI failed for ${user.email}:`, err.message);
      return false;
    }
  }

  /**
   * Identify power users and flag for testimonial requests
   */
  async identifyPowerUsers() {
    const powerUsers = await this.pool.query(`
      SELECT es.user_id, es.score, u.email, u.name
      FROM engagement_scores es
      JOIN users u ON es.user_id = u.id
      WHERE es.score >= 80
        AND NOT EXISTS (
          SELECT 1 FROM retention_actions ra
          WHERE ra.user_id = es.user_id AND ra.action_type = 'testimonial_request'
            AND ra.created_at >= NOW() - INTERVAL '60 days'
        )
    `);

    let flagged = 0;
    for (const user of powerUsers.rows) {
      await this.decisionQueue.enqueue(
        `Testimonial request: ${user.email} (power user, score: ${user.score})`,
        'marketing', 'low', 2,
        {
          action_type: 'testimonial_request',
          user_id: user.user_id,
          email: user.email,
          name: user.name,
          score: user.score,
          template: 'testimonial_request'
        },
        'system'
      );
      await this._recordAction(user.user_id, 'testimonial_request', `Power user, score: ${user.score}`);
      flagged++;
    }

    return flagged;
  }

  // ============================================
  // HELPERS
  // ============================================

  async _hasRecentAction(userId, actionType, days) {
    const result = await this.pool.query(
      'SELECT id FROM retention_actions WHERE user_id = $1 AND action_type = $2 AND created_at >= NOW() - $3::interval',
      [userId, actionType, `${days} days`]
    );
    return result.rows.length > 0;
  }

  async _recordAction(userId, actionType, triggerReason, metadata = {}) {
    await this.pool.query(
      'INSERT INTO retention_actions (user_id, action_type, trigger_reason, metadata) VALUES ($1, $2, $3, $4)',
      [userId, actionType, triggerReason, JSON.stringify(metadata)]
    );
  }
}

module.exports = RetentionService;
