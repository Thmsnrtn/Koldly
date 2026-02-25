module.exports = {
  name: 'add_analytics_tracking_fields',
  up: async (client) => {
    // Add user_agent column to capture browser/device info
    await client.query(`
      ALTER TABLE analytics_events
      ADD COLUMN IF NOT EXISTS user_agent TEXT
    `);

    // Add referrer column to capture traffic sources
    await client.query(`
      ALTER TABLE analytics_events
      ADD COLUMN IF NOT EXISTS referrer TEXT
    `);

    // Add session_id column to enable session tracking and funnel analysis
    await client.query(`
      ALTER TABLE analytics_events
      ADD COLUMN IF NOT EXISTS session_id TEXT
    `);

    // Create index on session_id for fast session queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_session_id ON analytics_events(session_id)
    `);

    console.log('Added user_agent, referrer, and session_id columns to analytics_events');
  }
};
