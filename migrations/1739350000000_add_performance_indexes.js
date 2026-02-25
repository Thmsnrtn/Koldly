module.exports = {
  name: 'add_performance_indexes',
  up: async (client) => {
    // Add indexes for common query patterns to improve performance

    // Index for email status queries (draft vs sent filtering)
    await client.query(`
      CREATE INDEX IF NOT EXISTS generated_emails_status_idx ON generated_emails(status)
    `);

    // Composite index for campaign + status queries (common in dashboard)
    await client.query(`
      CREATE INDEX IF NOT EXISTS generated_emails_campaign_status_idx
      ON generated_emails(campaign_id, status)
    `);

    // Index for timestamp-based queries (sorting by created_at)
    await client.query(`
      CREATE INDEX IF NOT EXISTS campaigns_created_at_idx ON campaigns(created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS prospects_created_at_idx ON prospects(created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS generated_emails_created_at_idx ON generated_emails(created_at DESC)
    `);

    // Index for sent_at queries (for tracking sent emails over time)
    await client.query(`
      CREATE INDEX IF NOT EXISTS generated_emails_sent_at_idx ON generated_emails(sent_at)
    `);

    // Composite index for prospect relevance sorting
    await client.query(`
      CREATE INDEX IF NOT EXISTS prospects_campaign_relevance_idx
      ON prospects(campaign_id, relevance_score DESC)
    `);

    // Index for user campaign lookups (filtered by status)
    await client.query(`
      CREATE INDEX IF NOT EXISTS campaigns_user_status_idx
      ON campaigns(user_id, status)
    `);
  }
};
