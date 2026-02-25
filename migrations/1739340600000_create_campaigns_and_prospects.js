module.exports = {
  name: 'create_campaigns_and_prospects',
  up: async (client) => {
    // Campaigns table - stores user-defined outreach campaigns
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        icp_description TEXT,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Prospects table - stores discovered prospects for each campaign
    await client.query(`
      CREATE TABLE IF NOT EXISTS prospects (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        company_name VARCHAR(255) NOT NULL,
        website VARCHAR(255),
        linkedin_url VARCHAR(255),
        industry VARCHAR(100),
        location VARCHAR(100),
        estimated_size VARCHAR(50),
        team_size VARCHAR(100),
        funding_stage VARCHAR(50),
        research_summary TEXT,
        pain_points TEXT,
        relevance_score INTEGER DEFAULT 50,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Generated emails table - stores AI-generated outreach emails
    await client.query(`
      CREATE TABLE IF NOT EXISTS generated_emails (
        id SERIAL PRIMARY KEY,
        prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        recipient_email VARCHAR(255),
        recipient_name VARCHAR(255),
        subject_line VARCHAR(255),
        email_body TEXT,
        personalization_notes TEXT,
        status VARCHAR(50) DEFAULT 'draft',
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for performance
    await client.query(`CREATE INDEX IF NOT EXISTS campaigns_user_id_idx ON campaigns(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prospects_campaign_id_idx ON prospects(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS generated_emails_campaign_id_idx ON generated_emails(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS generated_emails_prospect_id_idx ON generated_emails(prospect_id)`);
  }
};
