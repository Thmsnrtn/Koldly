const EmailService = require('./email-service');

/**
 * Campaign Sending Service
 * Manages scheduled sends, multi-step sequences, and stop-on-reply logic
 */
class CampaignSendingService {
  constructor(pool) {
    this.pool = pool;
    this.emailService = new EmailService(pool);
    this.logger = console;
  }

  /**
   * Track analytics event
   */
  async trackEvent(eventType, userId = null, metadata = {}) {
    try {
      await this.pool.query(`
        INSERT INTO analytics_events (event_type, user_id, metadata)
        VALUES ($1, $2, $3)
      `, [eventType, userId, JSON.stringify(metadata)]);

      this.logger.log(JSON.stringify({
        event: 'analytics_event',
        timestamp: new Date().toISOString(),
        event_type: eventType,
        user_id: userId,
        metadata: metadata
      }));
    } catch (err) {
      this.logger.error('[analytics] Tracking error:', err.message);
    }
  }

  /**
   * Start a campaign - initialize sending context and queue
   */
  async startCampaign(campaignId, userId, senderEmail, senderName = null, replyToEmail = null) {
    try {
      // Verify campaign ownership
      const campaignResult = await this.pool.query(
        `SELECT id FROM campaigns WHERE id = $1 AND user_id = $2`,
        [campaignId, userId]
      );

      if (campaignResult.rows.length === 0) {
        throw new Error('Campaign not found or access denied');
      }

      // Count prospects
      const prospectCount = await this.pool.query(
        `SELECT COUNT(*) as count FROM prospects WHERE campaign_id = $1`,
        [campaignId]
      );

      // Initialize or update campaign context
      await this.pool.query(
        `INSERT INTO campaign_sending_context
         (campaign_id, status, prospect_count, sender_email, sender_name, reply_to_email)
         VALUES ($1, 'active', $2, $3, $4, $5)
         ON CONFLICT (campaign_id) DO UPDATE
         SET status = 'active', prospect_count = $2, updated_at = NOW()`,
        [campaignId, prospectCount.rows[0].count, senderEmail, senderName || senderEmail.split('@')[0], replyToEmail || senderEmail]
      );

      // Enqueue all prospects' initial emails
      const emailsQueued = await this.queueInitialEmails(campaignId);

      this.logger.info(`Campaign started: ${campaignId} (${emailsQueued} emails queued)`);

      return {
        success: true,
        campaign_id: campaignId,
        emails_queued: emailsQueued,
        prospect_count: prospectCount.rows[0].count
      };
    } catch (err) {
      this.logger.error('Campaign start error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Queue all initial emails for a campaign
   */
  async queueInitialEmails(campaignId) {
    try {
      // Get all prospects with generated emails
      const result = await this.pool.query(
        `SELECT
          p.id as prospect_id,
          p.company_name,
          ge.id as generated_email_id,
          ge.recipient_email,
          ge.recipient_name,
          ge.subject_line,
          ge.email_body
         FROM prospects p
         LEFT JOIN generated_emails ge ON p.id = ge.prospect_id AND ge.campaign_id = $1
         WHERE p.campaign_id = $1 AND ge.id IS NOT NULL AND ge.status = 'approved'`,
        [campaignId]
      );

      const emails = result.rows;
      let queuedCount = 0;

      for (const email of emails) {
        // Check if already queued
        const existingQueue = await this.pool.query(
          `SELECT id FROM campaign_sending_queue
           WHERE prospect_id = $1 AND campaign_id = $2 AND is_followup = FALSE`,
          [email.prospect_id, campaignId]
        );

        if (existingQueue.rows.length === 0) {
          // Queue initial email for immediate send (or based on sending window)
          await this.pool.query(
            `INSERT INTO campaign_sending_queue
             (campaign_id, prospect_id, generated_email_id, recipient_email, recipient_name,
              subject_line, email_body, scheduled_for, is_followup, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), FALSE, 'pending')`,
            [campaignId, email.prospect_id, email.generated_email_id, email.recipient_email,
             email.recipient_name, email.subject_line, email.email_body]
          );
          queuedCount++;
        }
      }

      return queuedCount;
    } catch (err) {
      this.logger.error('Initial email queueing error:', err);
      return 0;
    }
  }

  /**
   * Process sending queue - send pending emails
   */
  async processSendingQueue() {
    try {
      // Get all pending emails that are ready to send
      const result = await this.pool.query(
        `SELECT
          q.id as queue_id,
          q.campaign_id,
          q.prospect_id,
          q.generated_email_id,
          q.recipient_email,
          q.recipient_name,
          q.subject_line,
          q.email_body,
          q.sequence_step_id,
          csc.status as campaign_status,
          csc.sending_window_start,
          csc.sending_window_end,
          csc.daily_send_limit,
          csc.emails_sent_today,
          csc.stop_on_reply,
          csc.sender_email,
          csc.sender_name,
          csc.reply_to_email,
          c.user_id
         FROM campaign_sending_queue q
         JOIN campaign_sending_context csc ON q.campaign_id = csc.campaign_id
         JOIN campaigns c ON q.campaign_id = c.id
         WHERE q.status = 'pending' AND csc.status = 'active' AND q.scheduled_for <= NOW()
         ORDER BY q.scheduled_for ASC
         LIMIT 100`
      );

      const queueItems = result.rows;
      let sentCount = 0;

      for (const item of queueItems) {
        // Check if campaign is within daily limit
        if (item.emails_sent_today >= item.daily_send_limit) {
          this.logger.info(`Campaign ${item.campaign_id} daily limit reached`);
          continue;
        }

        // Check if prospect has replied (if stop_on_reply enabled)
        if (item.stop_on_reply && item.sequence_step_id) {
          const replyCheck = await this.pool.query(
            `SELECT id FROM prospect_replies
             WHERE prospect_id = $1 AND campaign_id = $2`,
            [item.prospect_id, item.campaign_id]
          );

          if (replyCheck.rows.length > 0) {
            // Halt sequence
            await this.pool.query(
              `UPDATE campaign_sending_queue
               SET status = 'halted'
               WHERE prospect_id = $1 AND campaign_id = $2 AND is_followup = TRUE`,
              [item.prospect_id, item.campaign_id]
            );
            continue;
          }
        }

        // Send email
        const sendResult = await this.emailService.sendEmail(
          item.recipient_email,
          item.subject_line,
          item.email_body,
          {
            campaign_id: item.campaign_id,
            prospect_id: item.prospect_id,
            generated_email_id: item.generated_email_id,
            from_email: item.sender_email,
            reply_to: item.reply_to_email
          }
        );

        if (sendResult.success) {
          // Mark as sent
          await this.pool.query(
            `UPDATE campaign_sending_queue
             SET status = 'sent', sent_at = NOW(), attempt_count = attempt_count + 1, updated_at = NOW()
             WHERE id = $1`,
            [item.queue_id]
          );

          // Increment daily counter
          await this.pool.query(
            `UPDATE campaign_sending_context
             SET emails_sent_today = emails_sent_today + 1, last_sent_at = NOW()
             WHERE campaign_id = $1`,
            [item.campaign_id]
          );

          // Track email sent event
          await this.trackEvent('email_sent', item.user_id, {
            campaign_id: item.campaign_id,
            prospect_id: item.prospect_id,
            recipient_email: item.recipient_email
          }).catch(err => this.logger.error('Email sent tracking failed:', err.message));

          // Queue follow-ups if applicable
          if (!item.sequence_step_id) {
            await this.queueFollowupEmails(item.campaign_id, item.prospect_id);
          }

          sentCount++;
        } else {
          // Mark as failed with retry
          await this.pool.query(
            `UPDATE campaign_sending_queue
             SET status = 'failed', error_message = $1, attempt_count = attempt_count + 1, last_attempted_at = NOW()
             WHERE id = $2`,
            [sendResult.error, item.queue_id]
          );
        }
      }

      this.logger.info(`Sending queue processed: ${sentCount} emails sent`);
      return { success: true, emails_sent: sentCount };
    } catch (err) {
      this.logger.error('Queue processing error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Queue follow-up emails from sequence template
   */
  async queueFollowupEmails(campaignId, prospectId) {
    try {
      // Get the sequence template for this campaign
      const sequenceResult = await this.pool.query(
        `SELECT
          es.id as sequence_id,
          ess.id as step_id,
          ess.step_number,
          ess.days_after_initial,
          ess.subject_line,
          ess.email_body
         FROM email_sequences es
         JOIN email_sequence_steps ess ON es.id = ess.sequence_id
         WHERE es.campaign_id = $1 AND es.prospect_id = $2 AND ess.status = 'pending'
         ORDER BY ess.step_number ASC`,
        [campaignId, prospectId]
      );

      const steps = sequenceResult.rows;

      for (const step of steps) {
        // Calculate scheduled time
        const scheduledFor = new Date();
        scheduledFor.setDate(scheduledFor.getDate() + step.days_after_initial);

        // Get prospect email
        const prospectResult = await this.pool.query(
          `SELECT id FROM prospects WHERE id = $1`,
          [prospectId]
        );

        if (prospectResult.rows.length > 0) {
          // Queue the follow-up
          await this.pool.query(
            `INSERT INTO campaign_sending_queue
             (campaign_id, prospect_id, sequence_step_id, recipient_email, recipient_name,
              subject_line, email_body, scheduled_for, is_followup, status)
             SELECT $1, $2, $3, recipient_email, recipient_name, $4, $5, $6, TRUE, 'pending'
             FROM generated_emails
             WHERE prospect_id = $2 AND campaign_id = $1
             LIMIT 1`,
            [campaignId, prospectId, step.step_id, step.subject_line, step.email_body, scheduledFor]
          );
        }
      }

      this.logger.info(`Queued follow-up emails for prospect ${prospectId}`);
    } catch (err) {
      this.logger.error('Follow-up queueing error:', err);
    }
  }

  /**
   * Pause campaign
   */
  async pauseCampaign(campaignId, userId) {
    try {
      const result = await this.pool.query(
        `UPDATE campaign_sending_context
         SET status = 'paused', updated_at = NOW()
         WHERE campaign_id = $1`,
        [campaignId]
      );

      return { success: result.rowCount > 0 };
    } catch (err) {
      this.logger.error('Campaign pause error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Resume campaign
   */
  async resumeCampaign(campaignId, userId) {
    try {
      const result = await this.pool.query(
        `UPDATE campaign_sending_context
         SET status = 'active', updated_at = NOW()
         WHERE campaign_id = $1`,
        [campaignId]
      );

      return { success: result.rowCount > 0 };
    } catch (err) {
      this.logger.error('Campaign resume error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Add prospect to active campaign
   */
  async addProspectToCampaign(campaignId, prospectId, userId) {
    try {
      // Verify campaign ownership
      const campaign = await this.pool.query(
        `SELECT id FROM campaigns WHERE id = $1 AND user_id = $2`,
        [campaignId, userId]
      );

      if (campaign.rows.length === 0) {
        throw new Error('Campaign not found');
      }

      // Queue initial email for this prospect
      const emailResult = await this.pool.query(
        `SELECT id, recipient_email, recipient_name, subject_line, email_body
         FROM generated_emails
         WHERE prospect_id = $1 AND campaign_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [prospectId, campaignId]
      );

      if (emailResult.rows.length === 0) {
        throw new Error('No generated email found for prospect');
      }

      const email = emailResult.rows[0];

      await this.pool.query(
        `INSERT INTO campaign_sending_queue
         (campaign_id, prospect_id, generated_email_id, recipient_email, recipient_name,
          subject_line, email_body, scheduled_for, is_followup, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), FALSE, 'pending')`,
        [campaignId, prospectId, email.id, email.recipient_email, email.recipient_name,
         email.subject_line, email.email_body]
      );

      return { success: true };
    } catch (err) {
      this.logger.error('Add prospect error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Remove prospect from campaign
   */
  async removeProspectFromCampaign(campaignId, prospectId, userId) {
    try {
      // Verify campaign ownership
      const campaign = await this.pool.query(
        `SELECT id FROM campaigns WHERE id = $1 AND user_id = $2`,
        [campaignId, userId]
      );

      if (campaign.rows.length === 0) {
        throw new Error('Campaign not found');
      }

      // Mark queue items as cancelled
      await this.pool.query(
        `UPDATE campaign_sending_queue
         SET status = 'cancelled'
         WHERE campaign_id = $1 AND prospect_id = $2 AND status IN ('pending', 'failed')`,
        [campaignId, prospectId]
      );

      return { success: true };
    } catch (err) {
      this.logger.error('Remove prospect error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Get campaign sending status
   */
  async getCampaignStatus(campaignId, userId) {
    try {
      // Get campaign context
      const contextResult = await this.pool.query(
        `SELECT
          c.id, c.name, c.status,
          csc.status as sending_status,
          csc.prospect_count,
          csc.emails_sent_today,
          csc.daily_send_limit,
          csc.last_sent_at,
          csc.sender_email
         FROM campaigns c
         LEFT JOIN campaign_sending_context csc ON c.id = csc.campaign_id
         WHERE c.id = $1 AND c.user_id = $2`,
        [campaignId, userId]
      );

      if (contextResult.rows.length === 0) {
        return { success: false, error: 'Campaign not found' };
      }

      const context = contextResult.rows[0];

      // Get queue stats
      const queueStats = await this.pool.query(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM campaign_sending_queue
         WHERE campaign_id = $1`,
        [campaignId]
      );

      const stats = queueStats.rows[0];

      return {
        success: true,
        campaign: {
          id: context.id,
          name: context.name,
          status: context.sending_status || 'paused',
          prospects: context.prospect_count,
          sent_today: context.emails_sent_today,
          daily_limit: context.daily_send_limit,
          last_sent: context.last_sent_at,
          sender: context.sender_email
        },
        queue: {
          total: parseInt(stats.total),
          pending: parseInt(stats.pending || 0),
          sent: parseInt(stats.sent || 0),
          failed: parseInt(stats.failed || 0)
        }
      };
    } catch (err) {
      this.logger.error('Status check error:', err);
      return { success: false, error: err.message };
    }
  }
}

module.exports = CampaignSendingService;
