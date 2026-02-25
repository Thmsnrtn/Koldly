module.exports = {
  name: 'add_email_deliverability',
  up: async (client) => {
    // Email settings table - stores SPF/DKIM domain configuration per account
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        from_email VARCHAR(255) NOT NULL UNIQUE,
        from_name VARCHAR(255),
        sending_domain VARCHAR(255),
        spf_record VARCHAR(500),
        spf_verified BOOLEAN DEFAULT FALSE,
        dkim_record VARCHAR(500),
        dkim_selector VARCHAR(100),
        dkim_verified BOOLEAN DEFAULT FALSE,
        reply_to_email VARCHAR(255),
        company_name VARCHAR(255),
        unsubscribe_link_template VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Email warmup plan - gradual increase in sending volume per campaign
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_warmup_plans (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        day_number INTEGER NOT NULL,
        max_emails_per_day INTEGER DEFAULT 10,
        current_emails_sent_today INTEGER DEFAULT 0,
        warmup_start_date DATE DEFAULT CURRENT_DATE,
        completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(campaign_id, day_number)
      )
    `);

    // Email bounce log - track bounced emails and recipient status
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_bounces (
        id SERIAL PRIMARY KEY,
        generated_email_id INTEGER NOT NULL REFERENCES generated_emails(id) ON DELETE CASCADE,
        recipient_email VARCHAR(255) NOT NULL,
        bounce_type VARCHAR(50) NOT NULL,
        bounce_reason TEXT,
        bounce_details JSONB,
        detected_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Email recipient status - tracks validation and health of each recipient
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_recipient_status (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        recipient_email VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'valid',
        validation_type VARCHAR(50),
        format_valid BOOLEAN DEFAULT TRUE,
        mx_records_checked BOOLEAN DEFAULT FALSE,
        smtp_verified BOOLEAN DEFAULT FALSE,
        bounce_count INTEGER DEFAULT 0,
        complaint_count INTEGER DEFAULT 0,
        last_checked TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(campaign_id, recipient_email)
      )
    `);

    // Spam score log - track spam filter results before sending
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_spam_checks (
        id SERIAL PRIMARY KEY,
        generated_email_id INTEGER NOT NULL REFERENCES generated_emails(id) ON DELETE CASCADE,
        subject_line VARCHAR(255),
        email_body TEXT,
        spam_score DECIMAL(5,2),
        spam_test_results JSONB,
        flagged_keywords TEXT,
        recommendation VARCHAR(50),
        checked_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Sending rate limit config - prevent exceeding ISP/inbox provider rate limits
    await client.query(`
      CREATE TABLE IF NOT EXISTS sending_rate_limits (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        emails_per_minute INTEGER DEFAULT 5,
        emails_per_hour INTEGER DEFAULT 100,
        emails_per_day INTEGER DEFAULT 500,
        last_sent_at TIMESTAMPTZ,
        emails_sent_this_minute INTEGER DEFAULT 0,
        emails_sent_this_hour INTEGER DEFAULT 0,
        emails_sent_today INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(campaign_id)
      )
    `);

    // Email delivery status - comprehensive tracking of each sent email
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_delivery_status (
        id SERIAL PRIMARY KEY,
        generated_email_id INTEGER NOT NULL REFERENCES generated_emails(id) ON DELETE CASCADE,
        recipient_email VARCHAR(255) NOT NULL,
        delivery_status VARCHAR(50) DEFAULT 'pending',
        delivery_timestamp TIMESTAMPTZ,
        bounce_status VARCHAR(50),
        bounce_timestamp TIMESTAMPTZ,
        complaint_status VARCHAR(50),
        complaint_timestamp TIMESTAMPTZ,
        open_count INTEGER DEFAULT 0,
        first_opened_at TIMESTAMPTZ,
        last_opened_at TIMESTAMPTZ,
        click_count INTEGER DEFAULT 0,
        first_clicked_at TIMESTAMPTZ,
        last_clicked_at TIMESTAMPTZ,
        unsubscribed BOOLEAN DEFAULT FALSE,
        unsubscribe_timestamp TIMESTAMPTZ,
        message_id VARCHAR(255),
        external_message_id VARCHAR(255),
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for performance
    await client.query(`CREATE INDEX IF NOT EXISTS email_settings_user_id_idx ON email_settings(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS warmup_plans_campaign_id_idx ON email_warmup_plans(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS warmup_plans_day_idx ON email_warmup_plans(day_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS bounces_email_id_idx ON email_bounces(generated_email_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS bounces_recipient_idx ON email_bounces(recipient_email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS recipient_status_campaign_idx ON email_recipient_status(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS recipient_status_email_idx ON email_recipient_status(recipient_email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS recipient_status_status_idx ON email_recipient_status(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS spam_checks_email_id_idx ON email_spam_checks(generated_email_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS spam_checks_score_idx ON email_spam_checks(spam_score)`);
    await client.query(`CREATE INDEX IF NOT EXISTS rate_limits_campaign_idx ON sending_rate_limits(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS delivery_status_email_id_idx ON email_delivery_status(generated_email_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS delivery_status_recipient_idx ON email_delivery_status(recipient_email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS delivery_status_delivery_idx ON email_delivery_status(delivery_status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS delivery_status_sent_at_idx ON email_delivery_status(sent_at)`);
  }
};
