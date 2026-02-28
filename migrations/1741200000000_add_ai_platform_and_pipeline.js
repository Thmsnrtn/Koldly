module.exports = {
  name: 'add_ai_platform_and_pipeline',
  up: async (client) => {
    // AI response cache — input-hash keyed, Postgres-backed
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_cache (
        hash TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        task_type TEXT NOT NULL,
        response JSONB NOT NULL,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS ai_cache_expires_idx ON ai_cache(expires_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_cache_task_idx ON ai_cache(task_type)`);

    // AI usage tracking — per-call telemetry for cost monitoring
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        task_type TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cached BOOLEAN DEFAULT FALSE,
        cost_cents DECIMAL(10, 2) DEFAULT 0,
        latency_ms INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS ai_usage_user_id_idx ON ai_usage(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_usage_task_type_idx ON ai_usage(task_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_usage_created_at_idx ON ai_usage(created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_usage_model_idx ON ai_usage(model)`);

    // Reply drafts — AI-generated responses to prospect replies
    await client.query(`
      CREATE TABLE IF NOT EXISTS reply_drafts (
        id SERIAL PRIMARY KEY,
        reply_id INTEGER REFERENCES prospect_reply_inbox(id) ON DELETE CASCADE,
        prospect_id INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        draft_subject TEXT,
        draft_body TEXT NOT NULL,
        reply_category TEXT,
        status TEXT DEFAULT 'pending_approval',
        model_used TEXT,
        rejection_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS reply_drafts_status_idx ON reply_drafts(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS reply_drafts_reply_id_idx ON reply_drafts(reply_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS reply_drafts_campaign_id_idx ON reply_drafts(campaign_id)`);

    // Add product_description and onboarding fields to users
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS product_description TEXT,
      ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS sender_email VARCHAR(255),
      ADD COLUMN IF NOT EXISTS sender_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN DEFAULT FALSE
    `);

    // Add status tracking to prospects for pipeline view
    await client.query(`
      ALTER TABLE prospects
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'discovered',
      ADD COLUMN IF NOT EXISTS fit_score INTEGER DEFAULT 50,
      ADD COLUMN IF NOT EXISTS ai_reasoning TEXT
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS prospects_status_idx ON prospects(status)`);

    // Add ICP structured fields to campaigns
    await client.query(`
      ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS icp_structured JSONB,
      ADD COLUMN IF NOT EXISTS discovery_status TEXT DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS icp_template_id INTEGER
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS campaigns_discovery_status_idx ON campaigns(discovery_status)`);

    // Stripe event dedup table
    await client.query(`
      CREATE TABLE IF NOT EXISTS stripe_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        processed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Entitlements config per plan
    await client.query(`
      CREATE TABLE IF NOT EXISTS plan_entitlements (
        plan TEXT PRIMARY KEY,
        prospects_per_month INTEGER NOT NULL,
        max_campaigns INTEGER NOT NULL,
        ai_budget_cents INTEGER NOT NULL,
        features JSONB DEFAULT '{}'
      )
    `);

    // Seed entitlements
    await client.query(`
      INSERT INTO plan_entitlements (plan, prospects_per_month, max_campaigns, ai_budget_cents, features)
      VALUES
        ('free', 25, 1, 500, '{"auto_approve": false, "reply_drafts": false}'),
        ('starter', 100, 1, 1000, '{"auto_approve": false, "reply_drafts": true}'),
        ('growth', 500, 5, 5000, '{"auto_approve": false, "reply_drafts": true}'),
        ('scale', 2000, -1, 20000, '{"auto_approve": true, "reply_drafts": true}')
      ON CONFLICT (plan) DO NOTHING
    `);
  }
};
