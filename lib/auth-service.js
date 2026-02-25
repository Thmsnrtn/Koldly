/**
 * Authentication Service
 * Handles user registration, login, and token generation
 */

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { validatePassword } = require('./password-policy');

class AuthService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Register a new user
   */
  async signup(email, password, name) {
    // Validate email format
    if (!this._isValidEmail(email)) {
      throw new Error('Invalid email format');
    }

    // Validate password
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      throw new Error(passwordCheck.errors.join('; '));
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Insert user
    try {
      const result = await this.pool.query(
        'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
        [email.toLowerCase(), password_hash, name || null]
      );

      return result.rows[0];
    } catch (err) {
      if (err.code === '23505') { // Unique constraint violation
        throw new Error('Email already registered');
      }
      throw err;
    }
  }

  /**
   * Verify user credentials for login
   */
  async login(email, password) {
    // Get user by email
    const result = await this.pool.query(
      'SELECT id, email, password_hash, name FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid email or password');
    }

    const user = result.rows[0];

    // Compare password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      throw new Error('Invalid email or password');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name
    };
  }

  /**
   * Get user by ID
   */
  async getUserById(userId) {
    const result = await this.pool.query(
      'SELECT id, email, name, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  /**
   * Generate JWT token
   */
  generateToken(userId, expiresIn = '7d') {
    const payload = { userId };
    return jwt.sign(payload, process.env.JWT_SECRET || 'dev-secret-key', { expiresIn });
  }

  /**
   * Verify JWT token
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-key');
    } catch (err) {
      return null;
    }
  }

  /**
   * Validate email format
   */
  _isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  }

  /**
   * Generate a password reset token for a user
   * Returns the token and user email (for sending the email)
   */
  async generatePasswordResetToken(email) {
    // Look up user by email
    const result = await this.pool.query(
      'SELECT id, email FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    // Don't reveal whether email exists (security best practice)
    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0];

    // Generate secure random token (32 bytes = 64 hex characters)
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');

    // Token expires in 1 hour
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Store token in database
    await this.pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );

    return { token, email: user.email, userId: user.id };
  }

  /**
   * Verify a password reset token
   * Returns user info if valid, null if invalid/expired/used
   */
  async verifyPasswordResetToken(token) {
    const result = await this.pool.query(
      `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at, u.email
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const resetToken = result.rows[0];

    // Check if already used
    if (resetToken.used_at) {
      return null;
    }

    // Check if expired
    if (new Date() > new Date(resetToken.expires_at)) {
      return null;
    }

    return {
      tokenId: resetToken.id,
      userId: resetToken.user_id,
      email: resetToken.email
    };
  }

  /**
   * Reset user password using a valid token
   */
  async resetPassword(token, newPassword) {
    // Verify token is valid
    const tokenData = await this.verifyPasswordResetToken(token);
    if (!tokenData) {
      throw new Error('Invalid or expired reset token');
    }

    // Validate new password
    const passwordCheck = validatePassword(newPassword);
    if (!passwordCheck.valid) {
      throw new Error(passwordCheck.errors.join('; '));
    }

    // Hash new password
    const password_hash = await bcrypt.hash(newPassword, 10);

    // Update user password
    await this.pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [password_hash, tokenData.userId]
    );

    // Mark token as used
    await this.pool.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
      [tokenData.tokenId]
    );

    return { userId: tokenData.userId, email: tokenData.email };
  }
}

module.exports = AuthService;
