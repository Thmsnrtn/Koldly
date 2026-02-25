/**
 * Audit Logger - Track sensitive user actions
 *
 * Logs all sensitive operations for compliance and debugging:
 * - User authentication (login, signup, logout)
 * - Password changes
 * - Campaign creation/deletion
 * - Account changes (email, settings)
 *
 * Usage in route handlers:
 *   auditLogger.log(req.user.id, 'campaign.create', {
 *     campaignId: campaign.id,
 *     campaignName: campaign.title
 *   }, req);
 */

class AuditLogger {
  /**
   * Log an audit event
   * @param {number} userId - User ID
   * @param {string} action - Action name (e.g., 'login', 'campaign.create')
   * @param {Object} details - Action-specific details
   * @param {Request} req - Express request object
   */
  log(userId, action, details = {}, req = null) {
    const timestamp = new Date().toISOString();
    const ip = req?.ip || 'unknown';
    const userAgent = req?.headers['user-agent'] || 'unknown';

    const auditEvent = {
      timestamp,
      userId,
      action,
      details,
      ip,
      userAgent
    };

    // Log to console with consistent format
    console.log('[AUDIT]', JSON.stringify(auditEvent));

    // In production, this should also:
    // - Send to logging service (e.g., Sentry, CloudWatch)
    // - Store in audit table for historical queries
    // - Alert on suspicious patterns (5+ failed logins, etc.)
  }

  /**
   * Log user login attempt
   */
  logLogin(userId, success, req) {
    this.log(userId, 'auth.login', { success }, req);
  }

  /**
   * Log user signup
   */
  logSignup(userId, email, req) {
    this.log(userId, 'auth.signup', { email }, req);
  }

  /**
   * Log user logout
   */
  logLogout(userId, req) {
    this.log(userId, 'auth.logout', {}, req);
  }

  /**
   * Log password change
   */
  logPasswordChange(userId, req) {
    this.log(userId, 'auth.password_change', {}, req);
  }

  /**
   * Log password reset
   */
  logPasswordReset(userId, req) {
    this.log(userId, 'auth.password_reset', {}, req);
  }

  /**
   * Log email verification
   */
  logEmailVerified(userId, email, req) {
    this.log(userId, 'auth.email_verified', { email }, req);
  }

  /**
   * Log campaign creation
   */
  logCampaignCreate(userId, campaignId, campaignName, req) {
    this.log(userId, 'campaign.create', { campaignId, campaignName }, req);
  }

  /**
   * Log campaign deletion
   */
  logCampaignDelete(userId, campaignId, campaignName, req) {
    this.log(userId, 'campaign.delete', { campaignId, campaignName }, req);
  }

  /**
   * Log campaign update
   */
  logCampaignUpdate(userId, campaignId, campaignName, changes, req) {
    this.log(userId, 'campaign.update', { campaignId, campaignName, changes }, req);
  }

  /**
   * Log settings change
   */
  logSettingsChange(userId, setting, oldValue, newValue, req) {
    this.log(userId, 'settings.update', { setting, oldValue, newValue }, req);
  }

  /**
   * Log access to admin features
   */
  logAdminAccess(userId, feature, req) {
    this.log(userId, 'admin.access', { feature }, req);
  }

  /**
   * Log suspicious activity (multiple failed attempts, etc.)
   */
  logSuspiciousActivity(userId, activity, req) {
    this.log(userId, 'security.suspicious', { activity }, req);
  }
}

module.exports = new AuditLogger();
