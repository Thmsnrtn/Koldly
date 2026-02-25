module.exports = {
  name: 'add_password_reset_tokens',
  up: async (client) => {
    // Password reset tokens table - stores one-time use, time-limited reset tokens
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(255) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Index for fast token lookup
    await client.query(`
      CREATE INDEX IF NOT EXISTS password_reset_tokens_token_idx ON password_reset_tokens (token)
    `);

    // Index for cleanup queries (expired tokens)
    await client.query(`
      CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_at_idx ON password_reset_tokens (expires_at)
    `);

    // Index for user lookup
    await client.query(`
      CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx ON password_reset_tokens (user_id)
    `);
  },

  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS password_reset_tokens CASCADE');
  }
};
