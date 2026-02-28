module.exports = {
  name: 'add_is_admin',
  up: async (client) => {
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE
    `);

    // Grant admin to the founder account
    await client.query(`
      UPDATE users SET is_admin = true WHERE email = 'thmsnrtn@gmail.com'
    `);
  }
};
