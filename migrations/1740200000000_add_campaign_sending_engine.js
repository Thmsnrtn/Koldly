module.exports = {
  name: 'add_campaign_sending_engine',
  up: async (client) => {
    // Campaign sending queue - tracks scheduled email sends
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_sending_queue (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        generated_email_id INTEGER REFERENCES generated_emails(id) ON DELETE SET NULL,
        sequence_step_id INTEGER REFERENCES email_sequence_steps(id) ON DELETE SET NULL,
        recipient_email VARCHAR(255) NOT NULL,
        recipient_name VARCHAR(255),
        subject_line VARCHAR(255),
        email_body TEXT,
        scheduled_for TIMESTAMPTZ NOT NULL,
        sequence_step_number INTEGER,
        is_followup BOOLEAN DEFAULT FALSE,
        status VARCHAR(50) DEFAULT 'pending',
        sent_at TIMESTAMPTZ,
        last_attempted_at TIMESTAMPTZ,
        attempt_count INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Campaign sending context - tracks active campaigns & their state
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_sending_context (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL UNIQUE REFERENCES campaigns(id) ON DELETE CASCADE,
        status VARCHAR(50) DEFAULT 'paused',
        sending_window_start TIME DEFAULT '09:00:00',
        sending_window_end TIME DEFAULT '17:00:00',
        daily_send_limit INTEGER DEFAULT 50,
        emails_sent_today INTEGER DEFAULT 0,
        last_sent_at TIMESTAMPTZ,
        prospect_count INTEGER DEFAULT 0,
        sender_name VARCHAR(255),
        sender_email VARCHAR(255),
        reply_to_email VARCHAR(255),
        stop_on_reply BOOLEAN DEFAULT TRUE,
        timezone VARCHAR(50) DEFAULT 'UTC',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Prospect reply tracking - detect when prospect responds
    await client.query(`
      CREATE TABLE IF NOT EXISTS prospect_replies (
        id SERIAL PRIMARY KEY,
        prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        recipient_email VARCHAR(255) NOT NULL,
        reply_received_at TIMESTAMPTZ,
        sequence_halted_at TIMESTAMPTZ,
        reply_subject VARCHAR(255),
        reply_preview TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Sequence template - reusable email sequences for campaigns
    await client.query(`
      CREATE TABLE IF NOT EXISTS sequence_templates (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        step_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Sequence template steps
    await client.query(`
      CREATE TABLE IF NOT EXISTS sequence_template_steps (
        id SERIAL PRIMARY KEY,
        template_id INTEGER NOT NULL REFERENCES sequence_templates(id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL,
        days_after_initial INTEGER NOT NULL,
        subject_line VARCHAR(255),
        email_body TEXT,
        step_type VARCHAR(50) DEFAULT 'followup',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for performance
    await client.query(`CREATE INDEX IF NOT EXISTS campaign_sending_queue_campaign_id_idx ON campaign_sending_queue(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS campaign_sending_queue_status_idx ON campaign_sending_queue(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS campaign_sending_queue_scheduled_for_idx ON campaign_sending_queue(scheduled_for)`);
    await client.query(`CREATE INDEX IF NOT EXISTS campaign_sending_queue_prospect_id_idx ON campaign_sending_queue(prospect_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS campaign_sending_context_status_idx ON campaign_sending_context(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prospect_replies_campaign_id_idx ON prospect_replies(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prospect_replies_prospect_id_idx ON prospect_replies(prospect_id)`);
  }
};
