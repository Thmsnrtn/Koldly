class SlackService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Send a notification to Slack channel
   * @param {number} userId - User ID
   * @param {string} eventType - Event type
   * @param {object} data - Event data
   */
  async sendNotification(userId, eventType, data) {
    try {
      // Get Slack integration settings
      const settingsResult = await this.pool.query(
        `SELECT config FROM integration_settings
         WHERE user_id = $1 AND integration_type = 'slack' AND enabled = true
         LIMIT 1`,
        [userId]
      );

      if (settingsResult.rows.length === 0) {
        return { success: false, message: 'No Slack integration configured' };
      }

      const config = settingsResult.rows[0].config;
      const webhookUrl = config.webhook_url;

      if (!webhookUrl) {
        return { success: false, message: 'Slack webhook URL not configured' };
      }

      // Format message based on event type
      const message = this.formatMessage(eventType, data);

      // Send to Slack
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[SlackService] Failed to send notification:', errorText);
        return { success: false, error: errorText };
      }

      return { success: true };
    } catch (err) {
      console.error('[SlackService] sendNotification error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Format Slack message with blocks for rich formatting
   */
  formatMessage(eventType, data) {
    const timestamp = new Date().toISOString();

    switch (eventType) {
      case 'prospect.replied':
        return {
          text: `🎉 Prospect replied: ${data.company_name}`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '🎉 Prospect Replied!',
                emoji: true
              }
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Company:*\n${data.company_name}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Campaign:*\nCampaign #${data.campaign_id}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Reply Email:*\n${data.reply_from || 'N/A'}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Time:*\n${new Date(timestamp).toLocaleString()}`
                }
              ]
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `Prospect ID: ${data.prospect_id}`
                }
              ]
            }
          ]
        };

      case 'email.bounced':
        return {
          text: `⚠️ Email bounced: ${data.recipient_email}`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '⚠️ Email Bounced',
                emoji: true
              }
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Recipient:*\n${data.recipient_email}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Bounce Type:*\n${data.bounce_type || 'Unknown'}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Reason:*\n${data.description || 'N/A'}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Time:*\n${new Date(timestamp).toLocaleString()}`
                }
              ]
            }
          ]
        };

      case 'sequence.completed':
        return {
          text: `✅ Email sequence completed for Campaign #${data.campaign_id}`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '✅ Sequence Completed',
                emoji: true
              }
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Campaign:*\nCampaign #${data.campaign_id}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Prospect:*\nProspect #${data.prospect_id}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Total Steps:*\n${data.total_steps}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Completed:*\n${new Date(timestamp).toLocaleString()}`
                }
              ]
            }
          ]
        };

      case 'campaign.milestone':
        return {
          text: `🎯 Campaign milestone: ${data.milestone_type}`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '🎯 Campaign Milestone',
                emoji: true
              }
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Campaign:*\nCampaign #${data.campaign_id}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Milestone:*\n${data.milestone_type}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Value:*\n${data.value}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Time:*\n${new Date(timestamp).toLocaleString()}`
                }
              ]
            }
          ]
        };

      default:
        return {
          text: `Koldly notification: ${eventType}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Event:* ${eventType}\n*Data:* ${JSON.stringify(data, null, 2)}`
              }
            }
          ]
        };
    }
  }

  /**
   * Test Slack integration by sending a test message
   */
  async testIntegration(userId) {
    return this.sendNotification(userId, 'test', {
      message: 'This is a test notification from Koldly',
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = SlackService;
