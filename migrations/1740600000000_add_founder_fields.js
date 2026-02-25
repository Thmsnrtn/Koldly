module.exports = {
  name: 'add_founder_fields',
  up: async (client) => {
    // Add founder/billing_exempt flags to users table
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_founder BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS billing_exempt BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(50) DEFAULT 'free'
    `);
    
    // Create index for founder lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS users_is_founder_idx ON users (is_founder)
    `);
  }
};
