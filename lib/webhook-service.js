const crypto = require('crypto');

class WebhookService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Fire a webhook event to all registered webhooks for a user
   * @param {number} userId - User ID
   * @param {string} eventType - Event type (e.g., 'prospect.replied', 'email.bounced', 'sequence.completed')
   * @param {object} payload - Event payload data
   */
  async fireEvent(userId, eventType, payload) {
    try {
      // Get all enabled webhooks subscribed to this event type
      const webhooksResult = await this.pool.query(
        `SELECT id, url, secret_key FROM webhooks
         WHERE user_id = $1 AND enabled = true AND $2 = ANY(events)`,
        [userId, eventType]
      );

      const webhooks = webhooksResult.rows;
      if (webhooks.length === 0) {
        return { success: true, message: 'No webhooks registered for this event', delivered: 0 };
      }

      // Fire webhooks in parallel
      const deliveryPromises = webhooks.map(webhook =>
        this.deliverWebhook(webhook, eventType, payload)
      );

      const results = await Promise.allSettled(deliveryPromises);

      const delivered = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = results.length - delivered;

      return {
        success: true,
        total_webhooks: webhooks.length,
        delivered,
        failed
      };
    } catch (err) {
      console.error('[WebhookService] fireEvent error:', err);
      throw err;
    }
  }

  /**
   * Deliver a single webhook with signature and logging
   */
  async deliverWebhook(webhook, eventType, payload) {
    const startTime = Date.now();

    try {
      // Build Zapier-compatible payload
      const webhookPayload = {
        event: eventType,
        timestamp: new Date().toISOString(),
        data: payload
      };

      // Generate signature if secret key is set
      const signature = webhook.secret_key
        ? this.generateSignature(webhookPayload, webhook.secret_key)
        : null;

      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Koldly-Webhooks/1.0'
      };

      if (signature) {
        headers['X-Koldly-Signature'] = signature;
      }

      // Send webhook
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(webhookPayload),
        timeout: 10000 // 10 second timeout
      });

      const responseBody = await response.text();
      const duration = Date.now() - startTime;

      // Log webhook delivery
      await this.logWebhook(webhook.id, eventType, webhookPayload, response.status, responseBody, true, null);

      console.log(`[WebhookService] Delivered webhook to ${webhook.url} - ${response.status} (${duration}ms)`);

      return {
        success: response.ok,
        status: response.status,
        duration
      };
    } catch (err) {
      const duration = Date.now() - startTime;

      // Log failed delivery
      await this.logWebhook(webhook.id, eventType, payload, null, null, false, err.message);

      console.error(`[WebhookService] Failed to deliver webhook to ${webhook.url}:`, err.message);

      return {
        success: false,
        error: err.message,
        duration
      };
    }
  }

  /**
   * Generate HMAC signature for webhook verification
   */
  generateSignature(payload, secretKey) {
    const hmac = crypto.createHmac('sha256', secretKey);
    hmac.update(JSON.stringify(payload));
    return `sha256=${hmac.digest('hex')}`;
  }

  /**
   * Log webhook delivery attempt
   */
  async logWebhook(webhookId, eventType, payload, responseStatus, responseBody, delivered, error) {
    try {
      await this.pool.query(
        `INSERT INTO webhook_logs (webhook_id, event_type, payload, response_status, response_body, delivered, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [webhookId, eventType, payload, responseStatus, responseBody, delivered, error]
      );
    } catch (err) {
      console.error('[WebhookService] Failed to log webhook:', err);
    }
  }

  /**
   * Get webhook logs for a user
   */
  async getLogs(userId, limit = 50) {
    const result = await this.pool.query(
      `SELECT wl.*, w.url
       FROM webhook_logs wl
       JOIN webhooks w ON wl.webhook_id = w.id
       WHERE w.user_id = $1
       ORDER BY wl.attempted_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    return result.rows;
  }
}

module.exports = WebhookService;
