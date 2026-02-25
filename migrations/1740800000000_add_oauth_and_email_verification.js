module.exports = {
  name: 'add_oauth_and_email_verification',
  up: async (client) => {
    // Add OAuth and email verification columns to users table
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE,
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
    `);

    // Create email verification tokens table
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(255) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS email_verification_tokens_user_id_idx ON email_verification_tokens(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS email_verification_tokens_token_idx ON email_verification_tokens(token)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS users_google_id_idx ON users(google_id)
    `);
  }
};
