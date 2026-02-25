/**
 * OAuth Service
 * Handles Google OAuth 2.0 and email verification
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

class OAuthService {
  constructor(pool) {
    this.pool = pool;
    this.googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    this.googleClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    this.redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'https://koldly.com/auth/google/callback';
  }

  /**
   * Get Google OAuth authorization URL
   */
  getGoogleAuthUrl() {
    const params = new URLSearchParams({
      client_id: this.googleClientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      access_type: 'offline'
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Exchange Google authorization code for tokens
   */
  async exchangeCodeForTokens(code) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.googleClientId,
        client_secret: this.googleClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri
      })
    });

    if (!response.ok) {
      throw new Error('Failed to exchange code for tokens');
    }

    return response.json();
  }

  /**
   * Get user info from Google using access token
   */
  async getGoogleUserInfo(accessToken) {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      throw new Error('Failed to get Google user info');
    }

    return response.json();
  }

  /**
   * Handle Google OAuth callback - create or link account
   */
  async handleGoogleCallback(code) {
    // Exchange code for tokens
    const tokens = await this.exchangeCodeForTokens(code);

    // Get user info from Google
    const googleUser = await this.getGoogleUserInfo(tokens.access_token);

    const { sub: googleId, email, name, picture } = googleUser;

    // Check if user exists by email
    const existingUser = await this.pool.query(
      'SELECT id, email, name, google_id, email_verified FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (existingUser.rows.length > 0) {
      const user = existingUser.rows[0];

      // Link Google ID if not already linked
      if (!user.google_id) {
        await this.pool.query(
          'UPDATE users SET google_id = $1, email_verified = TRUE, verified_at = NOW() WHERE id = $2',
          [googleId, user.id]
        );
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        isNewUser: false
      };
    }

    // Create new user with Google OAuth
    const result = await this.pool.query(
      `INSERT INTO users (email, google_id, name, email_verified, verified_at)
       VALUES ($1, $2, $3, TRUE, NOW())
       RETURNING id, email, name`,
      [email, googleId, name || null]
    );

    return {
      id: result.rows[0].id,
      email: result.rows[0].email,
      name: result.rows[0].name,
      isNewUser: true
    };
  }

  /**
   * Generate email verification token
   */
  async generateVerificationToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await this.pool.query(
      'INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [userId, token, expiresAt]
    );

    return token;
  }

  /**
   * Verify email using token
   */
  async verifyEmailToken(token) {
    const result = await this.pool.query(
      `SELECT user_id, expires_at FROM email_verification_tokens
       WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid or expired verification token');
    }

    const { user_id } = result.rows[0];

    // Mark email as verified
    await this.pool.query(
      'UPDATE users SET email_verified = TRUE, verified_at = NOW() WHERE id = $1',
      [user_id]
    );

    // Delete used token
    await this.pool.query('DELETE FROM email_verification_tokens WHERE token = $1', [token]);

    return user_id;
  }

  /**
   * Resend verification email
   */
  async resendVerificationEmail(userId) {
    // Delete old tokens for this user
    await this.pool.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [userId]);

    // Generate new token
    const token = await this.generateVerificationToken(userId);

    // Get user email
    const user = await this.pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    if (user.rows.length === 0) {
      throw new Error('User not found');
    }

    return {
      token,
      email: user.rows[0].email
    };
  }

  /**
   * Check if email is verified
   */
  async isEmailVerified(userId) {
    const result = await this.pool.query(
      'SELECT email_verified FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    return result.rows[0].email_verified;
  }
}

module.exports = OAuthService;
