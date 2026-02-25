module.exports = {
  name: 'add_page_views',
  up: async (client) => {
    // Page views table - tracks website traffic for analytics
    await client.query(`
      CREATE TABLE IF NOT EXISTS page_views (
        id SERIAL PRIMARY KEY,
        path VARCHAR(500) NOT NULL,
        referrer VARCHAR(500),
        user_agent TEXT,
        ip VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for fast querying
    await client.query(`CREATE INDEX IF NOT EXISTS page_views_path_idx ON page_views(path)`);
    await client.query(`CREATE INDEX IF NOT EXISTS page_views_created_at_idx ON page_views(created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS page_views_ip_idx ON page_views(ip)`);
  }
};
