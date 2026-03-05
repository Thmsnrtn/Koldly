/**
 * Push Notification Service
 *
 * Sends APNs (Apple Push Notification Service) notifications to the iOS companion app.
 * Uses JWT-based APNs authentication (no certificates needed).
 *
 * Environment variables:
 *   APNS_KEY_ID        — 10-char key ID from Apple Developer portal
 *   APNS_TEAM_ID       — 10-char Apple Developer Team ID
 *   APNS_PRIVATE_KEY   — Contents of the .p8 private key file (with \n escaped as \\n)
 *   APNS_BUNDLE_ID     — App bundle ID (e.g. com.koldly.app)
 *   APNS_PRODUCTION    — 'true' for production APNs, 'false' for sandbox (default: sandbox)
 */

const https = require('https');
const crypto = require('crypto');

const APNS_HOST_PRODUCTION = 'api.push.apple.com';
const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';

// Notification types and their default titles
const NOTIFICATION_TEMPLATES = {
  new_approval_items: {
    title: 'New emails ready for review',
    body: (count) => `${count} email${count > 1 ? 's' : ''} waiting for your approval`
  },
  reply_received: {
    title: 'New reply received',
    body: (company) => `${company} replied to your outreach`
  },
  advisor_insight: {
    title: 'Campaign insight',
    body: (msg) => msg
  },
  sequence_completed: {
    title: 'Sequence complete',
    body: (campaign) => `All emails sent for "${campaign}"`
  }
};

class PushService {
  constructor(pool) {
    this.pool = pool;
    this._jwtCache = null;
    this._jwtCacheExpiry = 0;
  }

  /**
   * Send a push notification to all active devices for a user.
   *
   * @param {number} userId
   * @param {string} type - Notification type key from NOTIFICATION_TEMPLATES
   * @param {object} data - Template data (count, company name, etc.)
   * @param {object} extra - Additional APNs payload fields
   */
  async notifyUser(userId, type, data = {}, extra = {}) {
    if (!this._isConfigured()) {
      return; // APNs not configured — silently skip
    }

    // Get all active device tokens for this user
    let tokens;
    try {
      const result = await this.pool.query(
        `SELECT id, token, platform FROM device_tokens
         WHERE user_id = $1 AND active = TRUE AND platform = 'ios'`,
        [userId]
      );
      tokens = result.rows;
    } catch (err) {
      console.warn('[Push] Failed to fetch device tokens:', err.message);
      return;
    }

    if (tokens.length === 0) return;

    const template = NOTIFICATION_TEMPLATES[type];
    if (!template) {
      console.warn(`[Push] Unknown notification type: ${type}`);
      return;
    }

    // Build the notification body from template
    const bodyArg = Object.values(data)[0]; // Use first data value as template arg
    const notification = {
      aps: {
        alert: {
          title: template.title,
          body: typeof template.body === 'function' ? template.body(bodyArg) : template.body
        },
        badge: data.badge,
        sound: 'default',
        'mutable-content': 1
      },
      type,
      ...extra
    };

    // Send to all devices in parallel
    const results = await Promise.allSettled(
      tokens.map(t => this._sendToDevice(t, notification, userId, type))
    );

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      console.warn(`[Push] ${failed.length}/${tokens.length} notifications failed for user ${userId}`);
    }
  }

  /**
   * Register a device token for a user.
   * Called from POST /api/devices/register
   */
  async registerDevice(userId, token, platform = 'ios', appVersion = null, deviceModel = null) {
    await this.pool.query(
      `INSERT INTO device_tokens (user_id, token, platform, app_version, device_model, last_seen_at, active)
       VALUES ($1, $2, $3, $4, $5, NOW(), TRUE)
       ON CONFLICT (user_id, token) DO UPDATE
       SET last_seen_at = NOW(), active = TRUE, app_version = $4, device_model = $5, updated_at = NOW()`,
      [userId, token, platform, appVersion, deviceModel]
    );
  }

  /**
   * Deactivate a device token (called when app sends unregister or on invalid token error).
   */
  async deactivateDevice(userId, token) {
    await this.pool.query(
      `UPDATE device_tokens SET active = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND token = $2`,
      [userId, token]
    );
  }

  /**
   * Get unread approval queue count badge number for a user.
   */
  async getApprovalBadgeCount(userId) {
    try {
      const result = await this.pool.query(
        `SELECT COUNT(*) as count
         FROM generated_emails ge
         JOIN campaigns c ON ge.campaign_id = c.id
         WHERE c.user_id = $1 AND ge.status = 'pending_approval'`,
        [userId]
      );
      return parseInt(result.rows[0].count) || 0;
    } catch {
      return 0;
    }
  }

  // ---- Internal helpers ----

  _isConfigured() {
    return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID &&
              process.env.APNS_PRIVATE_KEY && process.env.APNS_BUNDLE_ID);
  }

  /**
   * Generate a JWT for APNs authentication (cached for 50 minutes, valid for 60).
   */
  _getJWT() {
    const now = Math.floor(Date.now() / 1000);
    if (this._jwtCache && this._jwtCacheExpiry > now + 300) {
      return this._jwtCache;
    }

    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: now })).toString('base64url');
    const signingInput = `${header}.${payload}`;

    const keyPem = (process.env.APNS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    const sign = crypto.createSign('SHA256');
    sign.update(signingInput);
    const signature = sign.sign({ key: keyPem, dsaEncoding: 'ieee-p1363' }, 'base64url');

    this._jwtCache = `${signingInput}.${signature}`;
    this._jwtCacheExpiry = now + 3000; // 50 minutes
    return this._jwtCache;
  }

  async _sendToDevice(device, notification, userId, type) {
    const host = process.env.APNS_PRODUCTION === 'true' ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
    const payload = JSON.stringify(notification);
    const jwt = this._getJWT();
    const bundleId = process.env.APNS_BUNDLE_ID;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: host,
        port: 443,
        path: `/3/device/${device.token}`,
        method: 'POST',
        headers: {
          'authorization': `bearer ${jwt}`,
          'apns-topic': bundleId,
          'apns-push-type': 'alert',
          'apns-expiration': '0',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, async (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', async () => {
          const success = res.statusCode === 200;
          const apnsId = res.headers['apns-id'];

          // Log push result
          try {
            await this.pool.query(
              `INSERT INTO push_notification_log
               (user_id, device_token_id, notification_type, title, body, payload, apns_id, status, error_message, sent_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                userId,
                device.id,
                type,
                notification.aps?.alert?.title,
                notification.aps?.alert?.body,
                JSON.stringify(notification),
                apnsId,
                success ? 'sent' : 'failed',
                success ? null : body.slice(0, 200),
                success ? new Date() : null
              ]
            );
          } catch (logErr) {
            // Non-blocking
          }

          if (!success) {
            // Handle invalid token (unregister device)
            if (res.statusCode === 410 || (body && body.includes('BadDeviceToken'))) {
              await this.deactivateDevice(userId, device.token).catch(() => {});
            }
            return reject(new Error(`APNs ${res.statusCode}: ${body.slice(0, 100)}`));
          }

          resolve({ apnsId, deviceId: device.id });
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('APNs request timed out')); });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = PushService;
