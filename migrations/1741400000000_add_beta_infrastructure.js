module.exports = {
  name: 'add_beta_infrastructure',
  up: async (client) => {
    // Beta user flag and activation tracking on users table
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_beta_user BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_cohort VARCHAR(50);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
    `);

    // Beta feedback collection table
    await client.query(`
      CREATE TABLE IF NOT EXISTS beta_feedback (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        rating INTEGER CHECK (rating >= 1 AND rating <= 5),
        what_worked TEXT,
        what_frustrated TEXT,
        would_recommend BOOLEAN,
        pricing_feedback TEXT,
        missing_features TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Track which lifecycle emails have been sent to avoid duplicates
    await client.query(`
      CREATE TABLE IF NOT EXISTS beta_emails_sent (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        email_key VARCHAR(50) NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, email_key)
      )
    `);

    // Index for efficient beta user queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_beta ON users (is_beta_user) WHERE is_beta_user = TRUE
    `);
  }
};
