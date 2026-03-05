/**
 * Migration: Device Tokens, Push Notifications, and AI Advisor Insights
 *
 * Enables:
 *   1. APNs/FCM push notifications for the iOS companion app
 *   2. AI GTM Advisor insights storage
 *   3. email_recipient_status unique constraint on email (not campaign+email)
 *      so the suppression list works globally across campaigns
 */
module.exports = {
  name: 'add_device_tokens_and_advisor',
  up: async (client) => {

    // ---- Device Tokens (iOS / Android push notifications) ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        platform VARCHAR(20) NOT NULL DEFAULT 'ios',
          -- ios | android | web
        app_version VARCHAR(50),
        device_model VARCHAR(100),
        last_seen_at TIMESTAMPTZ DEFAULT NOW(),
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, token)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON device_tokens(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS device_tokens_active_idx ON device_tokens(active, platform)`);

    // ---- AI GTM Advisor Insights ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS advisor_insights (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        insight_type VARCHAR(100) NOT NULL,
          -- follow_up_dropoff | unread_reply | icp_angle | sequence_gap | deliverability_warning
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        action_label VARCHAR(100),
        action_payload JSONB,
        priority VARCHAR(20) DEFAULT 'medium',
          -- high | medium | low
        read_at TIMESTAMPTZ,
        dismissed_at TIMESTAMPTZ,
        acted_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS advisor_user_idx ON advisor_insights(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS advisor_unread_idx ON advisor_insights(user_id, read_at) WHERE read_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS advisor_priority_idx ON advisor_insights(priority, created_at DESC)`);

    // ---- Push Notification Log ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_notification_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_token_id INTEGER REFERENCES device_tokens(id) ON DELETE SET NULL,
        notification_type VARCHAR(100) NOT NULL,
          -- new_approval_items | reply_received | advisor_insight | sequence_completed
        title VARCHAR(255),
        body TEXT,
        payload JSONB,
        apns_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
          -- pending | sent | failed | invalid_token
        error_message TEXT,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS push_log_user_idx ON push_notification_log(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS push_log_status_idx ON push_notification_log(status)`);

    // ---- Fix email_recipient_status for global suppression ----
    // The original migration uses (campaign_id, recipient_email) as unique key.
    // For a global suppression list, we need a separate table or a global unique on email.
    // Add a separate suppression list table for cross-campaign suppression.
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_suppression_list (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        reason VARCHAR(50) NOT NULL,
          -- hard_bounce | complaint | unsubscribe | manual
        source_campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        source_email_id INTEGER REFERENCES generated_emails(id) ON DELETE SET NULL,
        notes TEXT,
        added_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS suppression_email_idx ON email_suppression_list(email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS suppression_reason_idx ON email_suppression_list(reason)`);

    console.log('[Migration] Device tokens, advisor insights, and suppression list created');
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS email_suppression_list`);
    await client.query(`DROP TABLE IF EXISTS push_notification_log`);
    await client.query(`DROP TABLE IF EXISTS advisor_insights`);
    await client.query(`DROP TABLE IF EXISTS device_tokens`);
  }
};
