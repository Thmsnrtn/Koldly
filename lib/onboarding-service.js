/**
 * Onboarding Service
 *
 * Detects stuck users and classifies user types for adaptive onboarding.
 * Runs every 6 hours via scheduler. Actions flow through Decision Queue.
 */

const DecisionQueueService = require('./decision-queue-service');

class OnboardingService {
  constructor(pool) {
    this.pool = pool;
    this.decisionQueue = new DecisionQueueService(pool);
  }

  /**
   * Detect and nudge stuck users. Run every 6 hours.
   */
  async detectStuckUsers() {
    console.log('[Onboarding] Detecting stuck users');
    const results = { csv_nudge: 0, approval_nudge: 0, sender_nudge: 0, reengagement: 0 };

    // 1. Completed onboarding >48h ago, haven't imported CSV
    const noCsv = await this.pool.query(`
      SELECT u.id, u.email, u.name FROM users u
      WHERE u.onboarding_completed = true
        AND u.created_at <= NOW() - INTERVAL '48 hours'
        AND NOT EXISTS (
          SELECT 1 FROM analytics_events ae
          WHERE ae.user_id = u.id AND ae.event_type = 'csv_import'
        )
        AND NOT EXISTS (
          SELECT 1 FROM retention_actions ra
          WHERE ra.user_id = u.id AND ra.action_type = 'stuck_csv_nudge'
            AND ra.created_at >= NOW() - INTERVAL '7 days'
        )
      LIMIT 50
    `);

    for (const user of noCsv.rows) {
      await this.decisionQueue.enqueue(
        `Stuck: ${user.email} — no CSV import after 48h`,
        'onboarding', 'medium', 1,
        { action_type: 'stuck_csv_nudge', user_id: user.id, email: user.email, template: 'csv_nudge' },
        'system'
      );
      await this._recordAction(user.id, 'stuck_csv_nudge', 'No CSV import 48h post-onboarding');
      results.csv_nudge++;
    }

    // 2. Imported CSV >24h ago, haven't approved any emails
    const noApproval = await this.pool.query(`
      SELECT u.id, u.email, u.name FROM users u
      WHERE u.onboarding_completed = true
        AND EXISTS (
          SELECT 1 FROM analytics_events ae
          WHERE ae.user_id = u.id AND ae.event_type = 'csv_import'
            AND ae.created_at <= NOW() - INTERVAL '24 hours'
        )
        AND NOT EXISTS (
          SELECT 1 FROM analytics_events ae
          WHERE ae.user_id = u.id AND ae.event_type IN ('email_approved', 'email_edited_approved')
        )
        AND NOT EXISTS (
          SELECT 1 FROM retention_actions ra
          WHERE ra.user_id = u.id AND ra.action_type = 'stuck_approval_nudge'
            AND ra.created_at >= NOW() - INTERVAL '5 days'
        )
      LIMIT 50
    `);

    for (const user of noApproval.rows) {
      await this.decisionQueue.enqueue(
        `Stuck: ${user.email} — CSV imported but no approvals`,
        'onboarding', 'medium', 1,
        { action_type: 'stuck_approval_nudge', user_id: user.id, email: user.email, template: 'approval_nudge' },
        'system'
      );
      await this._recordAction(user.id, 'stuck_approval_nudge', 'CSV imported but no email approvals');
      results.approval_nudge++;
    }

    // 3. Approved emails >48h ago, haven't configured sender
    const noSender = await this.pool.query(`
      SELECT u.id, u.email, u.name FROM users u
      WHERE u.onboarding_completed = true
        AND u.activated_at IS NOT NULL
        AND u.activated_at <= NOW() - INTERVAL '48 hours'
        AND (u.sender_email IS NULL OR u.sender_email = '')
        AND NOT EXISTS (
          SELECT 1 FROM retention_actions ra
          WHERE ra.user_id = u.id AND ra.action_type = 'stuck_sender_nudge'
            AND ra.created_at >= NOW() - INTERVAL '7 days'
        )
      LIMIT 50
    `);

    for (const user of noSender.rows) {
      await this.decisionQueue.enqueue(
        `Stuck: ${user.email} — activated but no sender configured`,
        'onboarding', 'low', 1,
        { action_type: 'stuck_sender_nudge', user_id: user.id, email: user.email, template: 'sender_setup_nudge' },
        'system'
      );
      await this._recordAction(user.id, 'stuck_sender_nudge', 'Activated but no sender email configured');
      results.sender_nudge++;
    }

    // 4. Inactive for >7d after activation
    const inactive = await this.pool.query(`
      SELECT u.id, u.email, u.name FROM users u
      WHERE u.activated_at IS NOT NULL
        AND u.activated_at <= NOW() - INTERVAL '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM analytics_events ae
          WHERE ae.user_id = u.id AND ae.event_type = 'login'
            AND ae.created_at >= NOW() - INTERVAL '7 days'
        )
        AND NOT EXISTS (
          SELECT 1 FROM retention_actions ra
          WHERE ra.user_id = u.id AND ra.action_type = 'reengagement'
            AND ra.created_at >= NOW() - INTERVAL '14 days'
        )
      LIMIT 50
    `);

    for (const user of inactive.rows) {
      await this.decisionQueue.enqueue(
        `Re-engagement: ${user.email} — 7d+ inactive post-activation`,
        'retention', 'medium', 2,
        { action_type: 'reengagement', user_id: user.id, email: user.email, template: 'reengagement' },
        'system'
      );
      await this._recordAction(user.id, 'reengagement', '7+ days inactive after activation');
      results.reengagement++;
    }

    console.log(`[Onboarding] Stuck detection: csv=${results.csv_nudge}, approval=${results.approval_nudge}, sender=${results.sender_nudge}, reengagement=${results.reengagement}`);
    return results;
  }

  /**
   * Classify user type based on onboarding behavior.
   * Called once after user completes first meaningful action.
   */
  async classifyUserType(userId) {
    const user = await this.pool.query(`
      SELECT u.created_at, u.onboarding_completed, u.activated_at,
        (SELECT MIN(ae.created_at) FROM analytics_events ae WHERE ae.user_id = u.id AND ae.event_type = 'onboarding_completed') as onboarding_time,
        (SELECT MIN(ae.created_at) FROM analytics_events ae WHERE ae.user_id = u.id AND ae.event_type = 'csv_import') as first_csv,
        (SELECT MIN(ae.created_at) FROM analytics_events ae WHERE ae.user_id = u.id AND ae.event_type = 'first_email_approved') as first_approval,
        (SELECT COUNT(*) FROM analytics_events ae WHERE ae.user_id = u.id AND ae.event_type = 'email_edited_approved') as edit_count,
        (SELECT COUNT(*) FROM analytics_events ae WHERE ae.user_id = u.id AND ae.event_type = 'email_approved') as direct_approve_count
      FROM users u WHERE u.id = $1
    `, [userId]);

    if (user.rows.length === 0) return null;

    const u = user.rows[0];
    const signupTime = new Date(u.created_at).getTime();
    const onboardingTime = u.onboarding_time ? new Date(u.onboarding_time).getTime() : null;
    const firstCsv = u.first_csv ? new Date(u.first_csv).getTime() : null;
    const firstApproval = u.first_approval ? new Date(u.first_approval).getTime() : null;

    let userType = 'standard';

    if (onboardingTime && firstApproval) {
      const totalMinutes = (firstApproval - signupTime) / (1000 * 60);

      if (totalMinutes < 30) {
        userType = 'power_user';
      } else if (totalMinutes > 120 || parseInt(u.edit_count) > parseInt(u.direct_approve_count)) {
        userType = 'methodical';
      }
    } else if (onboardingTime && !firstCsv) {
      const daysSinceOnboarding = (Date.now() - onboardingTime) / (1000 * 60 * 60 * 24);
      if (daysSinceOnboarding > 3) {
        userType = 'hesitant';
      }
    }

    return { userId, userType, metrics: { edit_count: parseInt(u.edit_count), direct_approve_count: parseInt(u.direct_approve_count) } };
  }

  async _recordAction(userId, actionType, triggerReason) {
    await this.pool.query(
      'INSERT INTO retention_actions (user_id, action_type, trigger_reason) VALUES ($1, $2, $3)',
      [userId, actionType, triggerReason]
    );
  }
}

module.exports = OnboardingService;
