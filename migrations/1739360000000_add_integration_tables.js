module.exports = {
  name: 'add_integration_tables',
  up: async (client) => {
    // Integration settings - stores user webhook/Slack configs
    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        integration_type VARCHAR(50) NOT NULL, -- 'webhook' or 'slack'
        enabled BOOLEAN DEFAULT true,
        config JSONB NOT NULL, -- stores webhook URLs, Slack channel, auth tokens
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Webhooks table - registered webhook endpoints
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        events TEXT[] NOT NULL, -- array of subscribed events: ['prospect.replied', 'email.bounced', 'sequence.completed']
        secret_key VARCHAR(255), -- for webhook signature verification
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Webhook logs - tracks all webhook deliveries
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id SERIAL PRIMARY KEY,
        webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        response_status INTEGER,
        response_body TEXT,
        delivered BOOLEAN DEFAULT false,
        error TEXT,
        attempted_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes and constraints
    await client.query(`CREATE INDEX IF NOT EXISTS integration_settings_user_id_idx ON integration_settings(user_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS integration_settings_user_type_idx ON integration_settings(user_id, integration_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS webhooks_user_id_idx ON webhooks(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS webhook_logs_webhook_id_idx ON webhook_logs(webhook_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS webhook_logs_event_type_idx ON webhook_logs(event_type)`);
  }
};
