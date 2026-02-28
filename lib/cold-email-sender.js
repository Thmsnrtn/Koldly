/**
 * Cold Email Sender
 *
 * Configurable ESP for outbound cold email. Supports:
 * - Amazon SES (via @aws-sdk/client-ses or raw HTTPS)
 * - Mailgun (via HTTPS API)
 *
 * IMPORTANT: This is separate from the transactional EmailService (Postmark).
 * Postmark is used ONLY for transactional email (password reset, verification, welcome).
 * Cold outreach must use a cold-email-friendly ESP configured here.
 *
 * Configuration via environment variables:
 *   COLD_ESP_PROVIDER=ses|mailgun
 *   COLD_ESP_API_KEY=<your-api-key>
 *   COLD_ESP_DOMAIN=<your-sending-domain>  (Mailgun)
 *   COLD_ESP_REGION=us-east-1              (SES, optional)
 *   COLD_ESP_FROM_EMAIL=outreach@yourdomain.com
 */

const https = require('https');
const { URL } = require('url');

class ColdEmailSender {
  constructor() {
    this.provider = process.env.COLD_ESP_PROVIDER || null;
    this.apiKey = process.env.COLD_ESP_API_KEY || null;
    this.domain = process.env.COLD_ESP_DOMAIN || null;
    this.region = process.env.COLD_ESP_REGION || 'us-east-1';
    this.fromEmail = process.env.COLD_ESP_FROM_EMAIL || null;
    this.logger = console;

    if (!this.provider) {
      this.logger.warn('[ColdESP] COLD_ESP_PROVIDER not set. Cold email sending will be simulated.');
    }
  }

  /**
   * Check if cold email sending is configured
   */
  isConfigured() {
    return !!(this.provider && this.apiKey);
  }

  /**
   * Send a cold email via the configured ESP
   *
   * @param {object} params
   * @param {string} params.to - Recipient email
   * @param {string} params.toName - Recipient name (optional)
   * @param {string} params.from - Sender email (overrides env default)
   * @param {string} params.fromName - Sender name
   * @param {string} params.replyTo - Reply-to email
   * @param {string} params.subject - Email subject
   * @param {string} params.html - HTML body
   * @param {string} params.text - Plain text body (optional, auto-generated if missing)
   * @param {object} params.metadata - Custom metadata/tags
   * @returns {object} { success, message_id, provider, error }
   */
  async send(params) {
    const { to, toName, from, fromName, replyTo, subject, html, text, metadata } = params;

    if (!this.isConfigured()) {
      // Simulate send for development/testing
      const fakeId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.logger.log(`[ColdESP] SIMULATED send to ${to}: "${subject}" (no ESP configured)`);
      return {
        success: true,
        message_id: fakeId,
        provider: 'simulated',
        simulated: true
      };
    }

    const senderEmail = from || this.fromEmail;
    if (!senderEmail) {
      return { success: false, error: 'No sender email configured (set COLD_ESP_FROM_EMAIL)' };
    }

    try {
      switch (this.provider) {
        case 'ses':
          return await this._sendViaSES({ to, toName, from: senderEmail, fromName, replyTo, subject, html, text, metadata });
        case 'mailgun':
          return await this._sendViaMailgun({ to, toName, from: senderEmail, fromName, replyTo, subject, html, text, metadata });
        default:
          return { success: false, error: `Unknown ESP provider: ${this.provider}. Use 'ses' or 'mailgun'.` };
      }
    } catch (err) {
      this.logger.error(`[ColdESP] Send error (${this.provider}):`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Send via Amazon SES (v2 API over HTTPS)
   */
  async _sendViaSES(params) {
    // Using SES v2 SendEmail API via raw HTTPS (no SDK dependency)
    const { to, from, fromName, replyTo, subject, html, text } = params;

    const fromAddr = fromName ? `${fromName} <${from}>` : from;
    const payload = JSON.stringify({
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            ...(text ? { Text: { Data: text, Charset: 'UTF-8' } } : {})
          }
        }
      },
      Destination: {
        ToAddresses: [to]
      },
      FromEmailAddress: fromAddr,
      ...(replyTo ? { ReplyToAddresses: [replyTo] } : {})
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: `email.${this.region}.amazonaws.com`,
        path: '/v2/email/outbound-emails',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
          'Authorization': `Bearer ${this.apiKey}`
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              resolve({ success: true, message_id: parsed.MessageId, provider: 'ses' });
            } catch {
              resolve({ success: true, message_id: `ses_${Date.now()}`, provider: 'ses' });
            }
          } else {
            reject(new Error(`SES API error ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('SES request timeout')); });
      req.write(payload);
      req.end();
    });
  }

  /**
   * Send via Mailgun (HTTPS API)
   */
  async _sendViaMailgun(params) {
    const { to, toName, from, fromName, replyTo, subject, html, text } = params;

    if (!this.domain) {
      throw new Error('COLD_ESP_DOMAIN required for Mailgun');
    }

    const fromAddr = fromName ? `${fromName} <${from}>` : from;
    const toAddr = toName ? `${toName} <${to}>` : to;

    const formData = new URLSearchParams();
    formData.append('from', fromAddr);
    formData.append('to', toAddr);
    formData.append('subject', subject);
    formData.append('html', html);
    if (text) formData.append('text', text);
    if (replyTo) formData.append('h:Reply-To', replyTo);

    const body = formData.toString();
    const auth = Buffer.from(`api:${this.apiKey}`).toString('base64');

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.mailgun.net',
        path: `/v3/${this.domain}/messages`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Basic ${auth}`
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              resolve({ success: true, message_id: parsed.id, provider: 'mailgun' });
            } catch {
              resolve({ success: true, message_id: `mg_${Date.now()}`, provider: 'mailgun' });
            }
          } else {
            reject(new Error(`Mailgun API error ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Mailgun request timeout')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = ColdEmailSender;
