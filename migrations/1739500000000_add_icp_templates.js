module.exports = {
  name: 'add_icp_templates',
  up: async (client) => {
    // ICP Templates table - stores reusable ICP configurations
    await client.query(`
      CREATE TABLE IF NOT EXISTS icp_templates (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        icp_description TEXT NOT NULL,
        industry_filters TEXT[],
        size_filters TEXT[],
        location_filters TEXT[],
        is_favorite BOOLEAN DEFAULT false,
        usage_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add archived_at column to campaigns for soft delete
    await client.query(`
      ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ
    `);

    // Add is_archived column for quick filtering
    await client.query(`
      ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false
    `);

    // Add ICP template reference to campaigns
    await client.query(`
      ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS icp_template_id INTEGER REFERENCES icp_templates(id) ON DELETE SET NULL
    `);

    // Create indexes
    await client.query(`CREATE INDEX IF NOT EXISTS icp_templates_user_id_idx ON icp_templates(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS campaigns_is_archived_idx ON campaigns(is_archived)`);
  }
};
