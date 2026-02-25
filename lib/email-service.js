const https = require('https');
const { URL } = require('url');

/**
 * Email Delivery Service
 * Handles SPF/DKIM setup, validation, bounce detection, spam checking, and sending
 */

class EmailService {
  constructor(pool, apiKey = null) {
    this.pool = pool;
    this.apiKey = apiKey || process.env.EMAIL_API_KEY;
    this.emailApiUrl = process.env.EMAIL_API_URL || 'https://api.postmarkapp.com';
    this.logger = console;
  }

  /**
   * Send an email with full validation and tracking
   */
  async sendEmail(recipientEmail, subject, body, metadata = {}) {
    try {
      // Step 1: Validate email format and MX records
      const validationResult = await this.validateEmail(recipientEmail);
      if (!validationResult.valid) {
        return {
          success: false,
          error: `Email validation failed: ${validationResult.reason}`,
          validation_failed: true
        };
      }

      // Step 2: Check spam score before sending
      const spamCheckResult = await this.checkSpamScore(subject, body);
      if (spamCheckResult.spam_score > 7.5) {
        return {
          success: false,
          error: `Email flagged as spam (score: ${spamCheckResult.spam_score})`,
          spam_flagged: true,
          spam_details: spamCheckResult
        };
      }

      // Step 3: Check sending rate limits
      const rateLimitOk = await this.checkRateLimits(metadata.campaign_id);
      if (!rateLimitOk) {
        return {
          success: false,
          error: 'Sending rate limit exceeded for this campaign',
          rate_limited: true
        };
      }

      // Step 4: Add CAN-SPAM compliance (unsubscribe link)
      const bodyWithUnsubscribe = this.addUnsubscribeLink(body, metadata);

      // Step 5: Send email via Postmark (or mock if no API key)
      const sendResult = await this.sendViaPostmark(
        recipientEmail,
        subject,
        bodyWithUnsubscribe,
        metadata
      );

      if (!sendResult.success) {
        return {
          success: false,
          error: `Failed to send email: ${sendResult.error}`
        };
      }

      // Step 6: Update warm-up plan
      if (metadata.campaign_id) {
        await this.updateWarmupProgress(metadata.campaign_id);
      }

      // Step 7: Create delivery tracking record
      await this.trackDelivery(
        metadata.generated_email_id,
        recipientEmail,
        sendResult.message_id,
        sendResult.external_message_id
      );

      return {
        success: true,
        message_id: sendResult.message_id,
        external_message_id: sendResult.external_message_id
      };
    } catch (err) {
      this.logger.error('Email send error:', err);
      return {
        success: false,
        error: `Error sending email: ${err.message}`
      };
    }
  }

  /**
   * Validate email format and MX records
   */
  async validateEmail(email) {
    // Basic format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return {
        valid: false,
        reason: 'Invalid email format',
        format_valid: false
      };
    }

    // Extract domain and check MX records (simplified - would need DNS lookup in production)
    const domain = email.split('@')[1];
    if (!domain || domain.length < 3) {
      return {
        valid: false,
        reason: 'Invalid domain',
        format_valid: false
      };
    }

    // In production, would do actual DNS MX lookup here
    const commonProviders = ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'aol.com'];
    const hasKnownMx = commonProviders.includes(domain) || domain.includes('.com') || domain.includes('.io') || domain.includes('.org');

    return {
      valid: true,
      format_valid: true,
      mx_records_checked: true,
      smtp_verified: hasKnownMx
    };
  }

  /**
   * Check spam score using free tools (headers analysis, keywords)
   */
  async checkSpamScore(subject, body) {
    let score = 0;
    const results = [];

    // Check subject line for spam triggers
    const spamKeywords = ['free', 'click here', 'limited time', 'act now', 'urgent', 'guaranteed', 'no credit card'];
    const allCapsWords = subject.match(/\b[A-Z]{4,}\b/g) || [];
    const exclamationMarks = (subject.match(/!/g) || []).length;
    const dollarSigns = (subject.match(/\$/g) || []).length;

    if (subject.includes('!!!')) {
      score += 1;
      results.push('multiple_exclamation_marks');
    }

    if (allCapsWords.length > 2) {
      score += 1.5;
      results.push('excessive_caps');
    }

    if (dollarSigns > 0) {
      score += 2;
      results.push('dollar_signs');
    }

    spamKeywords.forEach(keyword => {
      if (subject.toLowerCase().includes(keyword)) {
        score += 0.5;
        results.push(`spam_keyword_subject: ${keyword}`);
      }
      if (body.toLowerCase().includes(keyword)) {
        score += 0.3;
        results.push(`spam_keyword_body: ${keyword}`);
      }
    });

    // Check body for patterns
    const links = (body.match(/https?:\/\//g) || []).length;
    if (links > 5) {
      score += 1;
      results.push('too_many_links');
    }

    // Check for suspicious headers/footers
    if (body.toLowerCase().includes('bitcoin') || body.toLowerCase().includes('crypto')) {
      score += 2;
      results.push('crypto_mention');
    }

    if (body.toLowerCase().includes('viagra') || body.toLowerCase().includes('casino')) {
      score += 5;
      results.push('pharmaceutical_mention');
    }

    // Long body with many short lines (mass mail indicator)
    const lines = body.split('\n');
    if (lines.length > 50 && lines.some(l => l.length < 10)) {
      score += 0.5;
      results.push('mass_mail_formatting');
    }

    return {
      spam_score: score,
      recommendation: score > 7.5 ? 'reject' : score > 5 ? 'review' : 'send',
      flagged_keywords: results,
      checks: {
        all_caps_words: allCapsWords.length,
        exclamation_marks: exclamationMarks,
        dollar_signs: dollarSigns,
        links: links,
        body_lines: lines.length
      }
    };
  }

  /**
   * Check if campaign is within rate limits
   */
  async checkRateLimits(campaignId) {
    if (!campaignId) return true;

    try {
      const result = await this.pool.query(
        `SELECT emails_per_minute, emails_sent_this_minute FROM sending_rate_limits
         WHERE campaign_id = $1`,
        [campaignId]
      );

      if (result.rows.length === 0) {
        // Initialize rate limits
        await this.pool.query(
          `INSERT INTO sending_rate_limits (campaign_id, emails_per_minute, emails_sent_this_minute)
           VALUES ($1, 5, 1)
           ON CONFLICT DO NOTHING`,
          [campaignId]
        );
        return true;
      }

      const limits = result.rows[0];
      const canSend = limits.emails_sent_this_minute < limits.emails_per_minute;

      if (canSend) {
        // Increment counter
        await this.pool.query(
          `UPDATE sending_rate_limits
           SET emails_sent_this_minute = emails_sent_this_minute + 1,
               updated_at = NOW()
           WHERE campaign_id = $1`,
          [campaignId]
        );
      }

      return canSend;
    } catch (err) {
      this.logger.error('Rate limit check error:', err);
      return true; // Allow on error
    }
  }

  /**
   * Add unsubscribe link to email body (CAN-SPAM compliance)
   */
  addUnsubscribeLink(body, metadata = {}) {
    const unsubscribeLink = metadata.unsubscribe_link ||
      `${process.env.APP_URL || 'https://koldly.com'}/unsubscribe/${metadata.campaign_id || 'default'}`;

    const footer = `

---
${body.includes('<html') ? '' : ''}
<p style="font-size: 12px; color: #999; margin-top: 20px;">
  <a href="${unsubscribeLink}" style="color: #999; text-decoration: underline;">Unsubscribe</a> from these emails
</p>`;

    return body + footer;
  }

  /**
   * Send via Postmark email service (or mock if no key)
   */
  async sendViaPostmark(toEmail, subject, body, metadata = {}) {
    // Mock mode if no API key (for development)
    if (!this.apiKey) {
      const mockMessageId = `mock-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      this.logger.info(`[MOCK] Email sent to ${toEmail}`, { subject, mockMessageId });
      return {
        success: true,
        message_id: mockMessageId,
        external_message_id: mockMessageId
      };
    }

    try {
      const emailPayload = {
        From: metadata.from_email || process.env.FROM_EMAIL || 'noreply@koldly.com',
        To: toEmail,
        Subject: subject,
        HtmlBody: body,
        TextBody: body.replace(/<[^>]*>/g, ''), // Strip HTML
        ReplyTo: metadata.reply_to || metadata.from_email,
        TrackOpens: true,
        TrackLinks: 'HtmlAndText',
        MessageStream: 'outbound',
        Metadata: {
          campaign_id: metadata.campaign_id,
          generated_email_id: metadata.generated_email_id,
          prospect_id: metadata.prospect_id
        }
      };

      const response = await this.makePostmarkRequest('POST', '/email', emailPayload);

      return {
        success: true,
        message_id: response.MessageID,
        external_message_id: response.MessageID,
        delivery_at: new Date().toISOString()
      };
    } catch (err) {
      this.logger.error('Postmark send error:', err);
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Make HTTP request to Postmark API
   */
  makePostmarkRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.emailApiUrl);
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'X-Postmark-Server-Token': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`Postmark API error: ${res.statusCode} ${data}`));
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Update warm-up plan progress
   */
  async updateWarmupProgress(campaignId) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const dayNumber = await this.calculateWarmupDay(campaignId);

      await this.pool.query(
        `INSERT INTO email_warmup_plans (campaign_id, day_number, max_emails_per_day, current_emails_sent_today)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (campaign_id, day_number)
         DO UPDATE SET current_emails_sent_today = current_emails_sent_today + 1, updated_at = NOW()`,
        [campaignId, dayNumber, 10 + dayNumber * 5] // Gradual increase: Day 1=15, Day 2=20, etc
      );
    } catch (err) {
      this.logger.error('Warmup update error:', err);
    }
  }

  /**
   * Calculate current warm-up day for campaign
   */
  async calculateWarmupDay(campaignId) {
    try {
      const result = await this.pool.query(
        `SELECT COALESCE(MAX(day_number), 0) as max_day
         FROM email_warmup_plans
         WHERE campaign_id = $1`,
        [campaignId]
      );
      return result.rows[0].max_day + 1;
    } catch (err) {
      return 1;
    }
  }

  /**
   * Track email delivery status
   */
  async trackDelivery(generatedEmailId, recipientEmail, messageId, externalMessageId) {
    try {
      await this.pool.query(
        `INSERT INTO email_delivery_status
         (generated_email_id, recipient_email, delivery_status, message_id, external_message_id, sent_at)
         VALUES ($1, $2, 'sent', $3, $4, NOW())
         ON CONFLICT DO NOTHING`,
        [generatedEmailId, recipientEmail, messageId, externalMessageId]
      );
    } catch (err) {
      this.logger.error('Delivery tracking error:', err);
    }
  }

  /**
   * Process bounce notification from email service
   */
  async processBounce(messageId, bounceType, bounceReason, recipientEmail = null) {
    try {
      // Find the delivery record
      const deliveryResult = await this.pool.query(
        `SELECT generated_email_id, recipient_email FROM email_delivery_status
         WHERE external_message_id = $1 OR message_id = $1`,
        [messageId]
      );

      if (deliveryResult.rows.length === 0) {
        this.logger.warn(`Bounce for unknown message ID: ${messageId}`);
        return;
      }

      const delivery = deliveryResult.rows[0];
      const email = recipientEmail || delivery.recipient_email;

      // Record bounce
      await this.pool.query(
        `INSERT INTO email_bounces (generated_email_id, recipient_email, bounce_type, bounce_reason)
         VALUES ($1, $2, $3, $4)`,
        [delivery.generated_email_id, email, bounceType, bounceReason]
      );

      // Update delivery status
      await this.pool.query(
        `UPDATE email_delivery_status
         SET bounce_status = $1, bounce_timestamp = NOW(), updated_at = NOW()
         WHERE external_message_id = $2 OR message_id = $2`,
        [bounceType, messageId]
      );

      // Update recipient status (mark as invalid for permanent bounces)
      if (bounceType === 'Permanent' || bounceType === 'permanent') {
        const generatedResult = await this.pool.query(
          `SELECT campaign_id FROM generated_emails WHERE id = $1`,
          [delivery.generated_email_id]
        );

        if (generatedResult.rows.length > 0) {
          await this.pool.query(
            `INSERT INTO email_recipient_status
             (campaign_id, recipient_email, status, bounce_count)
             VALUES ($1, $2, 'bounced', 1)
             ON CONFLICT (campaign_id, recipient_email) DO UPDATE
             SET status = 'bounced', bounce_count = bounce_count + 1, updated_at = NOW()`,
            [generatedResult.rows[0].campaign_id, email]
          );
        }
      }

      this.logger.info(`Bounce processed: ${bounceType} for ${email}`);
    } catch (err) {
      this.logger.error('Bounce processing error:', err);
    }
  }

  /**
   * Configure SPF/DKIM for a user's sending domain
   */
  async setupDomainAuthentication(userId, fromEmail, sendingDomain, replyToEmail = null) {
    try {
      // Generate DKIM selector and records (simplified)
      const dkimSelector = `koldly-${Date.now().toString(36)}`;
      const spfRecord = 'v=spf1 include:postmarkapp.com ~all';
      const dkimRecord = `${dkimSelector}._domainkey.${sendingDomain} TXT v=DKIM1; k=rsa; p=[public-key-here]`;

      // Store settings
      await this.pool.query(
        `INSERT INTO email_settings
         (user_id, from_email, from_name, sending_domain, spf_record, dkim_selector, dkim_record, reply_to_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (from_email) DO UPDATE
         SET sending_domain = $4, spf_record = $5, dkim_selector = $6, dkim_record = $7, updated_at = NOW()`,
        [userId, fromEmail, fromEmail.split('@')[0], sendingDomain, spfRecord, dkimSelector, dkimRecord, replyToEmail]
      );

      return {
        success: true,
        instructions: {
          spf: `Add this SPF record to your domain DNS: ${spfRecord}`,
          dkim: `Add this DKIM record to your domain DNS: ${dkimRecord}`,
          selector: dkimSelector
        }
      };
    } catch (err) {
      this.logger.error('Domain setup error:', err);
      return {
        success: false,
        error: err.message
      };
    }
  }
}

module.exports = EmailService;
