/**
 * Seed founder account for thmsnrtn@gmail.com
 * Sets up Scale tier with billing exemption
 */
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function seedFounder() {
  const client = await pool.connect();
  try {
    const email = 'thmsnrtn@gmail.com';
    const temporaryPassword = 'ChangeMeNow123!'; // Will be changed on first login
    
    // Check if user exists
    const existingUser = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (existingUser.rows.length > 0) {
      // User exists - upgrade to Scale tier AND reset password
      const userId = existingUser.rows[0].id;
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);
      await client.query(
        `UPDATE users
         SET is_founder = true,
             billing_exempt = true,
             subscription_tier = 'scale',
             subscription_status = 'active',
             password_hash = $2
         WHERE id = $1`,
        [userId, passwordHash]
      );
      console.log(`✓ Upgraded existing user ${email} to Scale tier (founder, billing exempt)`);
      console.log(`  Temporary password: ${temporaryPassword}`);
    } else {
      // Create new founder account
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);
      const result = await client.query(
        `INSERT INTO users 
         (email, password_hash, name, is_founder, billing_exempt, subscription_tier, subscription_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, email`,
        [email.toLowerCase(), passwordHash, 'Founder', true, true, 'scale', 'active']
      );
      console.log(`✓ Created founder account: ${email}`);
      console.log(`  Temporary password: ${temporaryPassword}`);
      console.log(`  User ID: ${result.rows[0].id}`);
    }

    console.log('\n✓ Founder seeding complete');
  } catch (err) {
    console.error('Error seeding founder:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seedFounder();
