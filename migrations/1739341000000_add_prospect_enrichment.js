module.exports = {
  name: 'add_prospect_enrichment',
  up: async (client) => {
    // Add enrichment columns to prospects table if they don't already exist
    await client.query(`
      ALTER TABLE prospects
      ADD COLUMN IF NOT EXISTS linkedin_url VARCHAR(255),
      ADD COLUMN IF NOT EXISTS team_size VARCHAR(100),
      ADD COLUMN IF NOT EXISTS funding_stage VARCHAR(50),
      ADD COLUMN IF NOT EXISTS relevance_score INTEGER DEFAULT 50
    `);
  }
};
