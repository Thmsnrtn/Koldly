module.exports = {
  name: 'add_subscription_fields',
  up: async (client) => {
    // Add Stripe customer ID and subscription status to users table
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'free'
    `);

    // Create index for Stripe lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS users_stripe_customer_id_idx ON users (stripe_customer_id)
    `);
  }
};
