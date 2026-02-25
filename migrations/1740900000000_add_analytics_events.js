module.exports = {
  name: 'add_analytics_events',
  up: async (client) => {
    // Analytics events table - tracks user actions and page views for metrics
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for fast querying
    await client.query(`CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics_events(event_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_analytics_created_at ON analytics_events(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_analytics_user_id ON analytics_events(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_analytics_event_type_created_at ON analytics_events(event_type, created_at DESC)`);
  }
};
