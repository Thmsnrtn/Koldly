/**
 * Migration: Agent Workflows and AI Video Tasks
 *
 * Adds:
 *   - agent_workflows: Multi-agent DAG state persistence
 *   - video_tasks: AI video generation queue
 *   - inbox_placement_tests: GlockApps inbox placement results
 */
module.exports = {
  name: 'add_agent_workflows_and_video',
  up: async (client) => {

    // ---- Agent Workflows ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_workflows (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workflow_type VARCHAR(100) NOT NULL,
          -- campaign_architect | email_optimizer | prospect_researcher
        status VARCHAR(50) NOT NULL DEFAULT 'running',
          -- running | awaiting_human | completed | failed
        current_node VARCHAR(100),
          -- research | copywriter | critic | human_gate | optimizer | complete
        input_context JSONB DEFAULT '{}',
        node_outputs JSONB DEFAULT '{}',
        final_output JSONB,
        error_message TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS agent_workflows_user_idx ON agent_workflows(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agent_workflows_campaign_idx ON agent_workflows(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agent_workflows_status_idx ON agent_workflows(status, created_at DESC)`);

    // ---- Video Tasks ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_tasks (
        id SERIAL PRIMARY KEY,
        prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL DEFAULT 'tavus',
          -- tavus | heygen
        external_video_id TEXT,
        script TEXT,
        opening_hook TEXT,
        estimated_seconds INTEGER,
        status VARCHAR(50) NOT NULL DEFAULT 'rendering',
          -- rendering | ready | failed | approved | sent
        download_url TEXT,
        stream_url TEXT,
        landing_page_url TEXT,
        approved_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        ready_at TIMESTAMPTZ,
        view_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS video_tasks_user_idx ON video_tasks(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS video_tasks_status_idx ON video_tasks(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS video_tasks_prospect_idx ON video_tasks(prospect_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS video_tasks_external_idx ON video_tasks(external_video_id)`);

    // ---- Inbox Placement Tests ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS inbox_placement_tests (
        id SERIAL PRIMARY KEY,
        test_id TEXT NOT NULL UNIQUE,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        inbox_rate INTEGER,
        spam_rate INTEGER,
        total_seeds INTEGER,
        provider_breakdown JSONB,
        raw_results JSONB,
        initiated_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS placement_tests_campaign_idx ON inbox_placement_tests(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS placement_tests_test_id_idx ON inbox_placement_tests(test_id)`);

    console.log('[Migration] Agent workflows, video tasks, and inbox placement tests created');
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS inbox_placement_tests`);
    await client.query(`DROP TABLE IF EXISTS video_tasks`);
    await client.query(`DROP TABLE IF EXISTS agent_workflows`);
  }
};
