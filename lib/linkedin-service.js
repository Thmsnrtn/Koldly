/**
 * LinkedIn Outreach Service
 *
 * Manages LinkedIn outreach tasks (connection requests, InMails, messages)
 * as a parallel channel alongside email campaigns.
 *
 * Architecture: LinkedIn tasks flow through the same ApprovalService
 * queue as emails — every task requires human approval before execution.
 * Execution is delegated to Phantombuster (or a Chrome Extension relay).
 *
 * Environment variables:
 *   PHANTOMBUSTER_API_KEY — Phantombuster API key (optional; without it,
 *                           tasks are queued for Chrome Extension relay)
 *   PHANTOMBUSTER_AGENT_CONNECT  — Agent ID for LinkedIn connection requests
 *   PHANTOMBUSTER_AGENT_MESSAGE  — Agent ID for LinkedIn messages
 */

const https = require('https');

const PHANTOMBUSTER_BASE = 'https://api.phantombuster.com/api/v2';

// LinkedIn message character limits
const LIMITS = {
  connection_request: 300,  // Connection note character limit
  inmail: 2000,
  message: 8000
};

function phantombusterRequest(path, body) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.PHANTOMBUSTER_API_KEY;
    if (!apiKey) throw new Error('PHANTOMBUSTER_API_KEY not configured');

    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.phantombuster.com',
      port: 443,
      path: `/api/v2${path}`,
      method: 'POST',
      headers: {
        'X-Phantombuster-Key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) throw new Error(`Phantombuster ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve(JSON.parse(data));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Phantombuster request timed out')); });
    req.write(payload);
    req.end();
  });
}

class LinkedInService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Generate a personalized LinkedIn connection request or message for a prospect.
   * Uses AI to craft the message, then inserts as pending_approval in linkedin_tasks.
   *
   * @param {object} options
   *   { campaignId, prospectId, userId, taskType, ai }
   */
  async generateLinkedInTask(options) {
    const { campaignId, prospectId, userId, taskType = 'connect_request', ai } = options;

    // Get prospect and campaign context
    const prospectResult = await this.pool.query(
      `SELECT p.*, c.description as campaign_description, c.icp_description
       FROM prospects p
       JOIN campaigns c ON p.campaign_id = c.id
       WHERE p.id = $1 AND c.user_id = $2`,
      [prospectId, userId]
    );

    if (prospectResult.rows.length === 0) throw new Error('Prospect not found');
    const prospect = prospectResult.rows[0];

    if (!prospect.linkedin_url && taskType !== 'inmail') {
      throw new Error(`Prospect ${prospect.company_name} has no LinkedIn URL`);
    }

    const charLimit = LIMITS[taskType] || 300;

    const result = await ai.callJSON('linkedin_message_draft', {
      system: `You are a B2B sales expert writing a LinkedIn ${taskType.replace('_', ' ')}.
The message must be:
- Genuinely personalized to this specific prospect
- Concise and human — NOT salesy or template-like
- Under ${charLimit} characters (this is a hard limit)
- No emojis unless clearly appropriate for their industry
- No "I came across your profile" or "I hope this message finds you well"

Return JSON: {
  "message": "string (the full message text, max ${charLimit} chars)",
  "personalization_hook": "string (the specific detail you personalized on)",
  "char_count": number
}`,
      messages: [{
        role: 'user',
        content: [
          `Company: ${prospect.company_name}`,
          `Contact: ${[prospect.contact_first_name, prospect.contact_last_name].filter(Boolean).join(' ') || 'Unknown'}`,
          `Title: ${prospect.contact_title || 'Unknown'}`,
          `Industry: ${prospect.industry || 'Unknown'}`,
          `Location: ${prospect.location || 'Unknown'}`,
          `Company size: ${prospect.estimated_size || 'Unknown'}`,
          `Research: ${prospect.research_summary || prospect.pain_points || 'None available'}`,
          `Our product: ${prospect.campaign_description || 'Not specified'}`,
          `Task type: ${taskType}`
        ].join('\n')
      }]
    }, { userId });

    const draft = result.content;

    // Truncate to hard limit if AI exceeded it
    if (draft.message && draft.message.length > charLimit) {
      draft.message = draft.message.slice(0, charLimit - 3) + '...';
    }

    // Insert as pending_approval
    const insertResult = await this.pool.query(
      `INSERT INTO linkedin_tasks
       (campaign_id, prospect_id, user_id, task_type, content, personalization_hook,
        char_count, status, linkedin_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval', $8)
       RETURNING id`,
      [
        campaignId, prospectId, userId, taskType,
        draft.message, draft.personalization_hook,
        draft.char_count || draft.message?.length || 0,
        prospect.linkedin_url || null
      ]
    );

    return {
      id: insertResult.rows[0].id,
      task_type: taskType,
      content: draft.message,
      personalization_hook: draft.personalization_hook,
      prospect: prospect.company_name
    };
  }

  /**
   * Execute an approved LinkedIn task via Phantombuster.
   * Called after a task is approved in the approval queue.
   */
  async executeTask(taskId, userId) {
    const result = await this.pool.query(
      `SELECT lt.*, p.linkedin_url, p.company_name
       FROM linkedin_tasks lt
       JOIN prospects p ON lt.prospect_id = p.id
       WHERE lt.id = $1 AND lt.user_id = $2 AND lt.status = 'approved'`,
      [taskId, userId]
    );

    if (result.rows.length === 0) throw new Error('Task not found or not approved');
    const task = result.rows[0];

    if (!process.env.PHANTOMBUSTER_API_KEY) {
      // Queue for Chrome Extension relay instead
      await this.pool.query(
        `UPDATE linkedin_tasks SET status = 'queued_for_extension', updated_at = NOW() WHERE id = $1`,
        [taskId]
      );
      return { success: true, method: 'extension_relay', task_id: taskId };
    }

    // Execute via Phantombuster
    try {
      const agentId = task.task_type === 'connect_request'
        ? process.env.PHANTOMBUSTER_AGENT_CONNECT
        : process.env.PHANTOMBUSTER_AGENT_MESSAGE;

      if (!agentId) throw new Error(`No Phantombuster agent configured for ${task.task_type}`);

      await phantombusterRequest('/agents/launch', {
        id: agentId,
        argument: JSON.stringify({
          profileUrl: task.linkedin_url,
          message: task.content,
          numberOfProfiles: 1
        })
      });

      await this.pool.query(
        `UPDATE linkedin_tasks
         SET status = 'sent', sent_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [taskId]
      );

      return { success: true, method: 'phantombuster', task_id: taskId };
    } catch (err) {
      await this.pool.query(
        `UPDATE linkedin_tasks
         SET status = 'failed', error_message = $1, updated_at = NOW()
         WHERE id = $1`,
        [err.message.slice(0, 500), taskId]
      );
      throw err;
    }
  }

  /**
   * Generate LinkedIn tasks for all prospects in a campaign that have LinkedIn URLs
   * and haven't been contacted on LinkedIn yet.
   */
  async generateCampaignLinkedInTasks(campaignId, userId, ai, batchSize = 10) {
    const prospects = await this.pool.query(
      `SELECT p.id FROM prospects p
       WHERE p.campaign_id = $1
         AND p.linkedin_url IS NOT NULL
         AND p.status IN ('researched', 'email_drafted', 'email_sent')
         AND NOT EXISTS (
           SELECT 1 FROM linkedin_tasks lt
           WHERE lt.prospect_id = p.id AND lt.campaign_id = $1
         )
       LIMIT $2`,
      [campaignId, batchSize]
    );

    const generated = [];
    for (const row of prospects.rows) {
      try {
        const task = await this.generateLinkedInTask({
          campaignId, prospectId: row.id, userId, taskType: 'connect_request', ai
        });
        generated.push(task);
      } catch (err) {
        console.warn(`[LinkedIn] Task generation failed for prospect ${row.id}:`, err.message);
      }
    }

    return { generated: generated.length, tasks: generated };
  }

  /**
   * Get LinkedIn task queue for the approval view.
   */
  async getTaskQueue(userId, filters = {}) {
    const { campaignId, status = 'pending_approval', limit = 50 } = filters;
    const params = [userId, status, limit];
    let whereExtra = '';

    if (campaignId) {
      whereExtra = 'AND lt.campaign_id = $4';
      params.push(campaignId);
    }

    const result = await this.pool.query(
      `SELECT
         lt.*,
         p.company_name, p.contact_first_name, p.contact_last_name,
         p.contact_title, p.linkedin_url, p.industry,
         c.name as campaign_name,
         'linkedin' as item_type
       FROM linkedin_tasks lt
       JOIN prospects p ON lt.prospect_id = p.id
       JOIN campaigns c ON lt.campaign_id = c.id
       WHERE c.user_id = $1 AND lt.status = $2 ${whereExtra}
       ORDER BY lt.created_at DESC
       LIMIT $3`,
      params
    );

    return result.rows;
  }

  /**
   * Approve a LinkedIn task.
   */
  async approveTask(taskId, userId) {
    const result = await this.pool.query(
      `UPDATE linkedin_tasks lt SET status = 'approved', updated_at = NOW()
       FROM campaigns c
       WHERE lt.campaign_id = c.id AND c.user_id = $1 AND lt.id = $2
         AND lt.status = 'pending_approval'
       RETURNING lt.id`,
      [userId, taskId]
    );

    if (result.rows.length === 0) throw new Error('Task not found or already processed');

    // Execute immediately after approval
    return this.executeTask(taskId, userId);
  }

  /**
   * Reject a LinkedIn task.
   */
  async rejectTask(taskId, userId, reason = null) {
    await this.pool.query(
      `UPDATE linkedin_tasks lt SET status = 'rejected', rejection_reason = $3, updated_at = NOW()
       FROM campaigns c
       WHERE lt.campaign_id = c.id AND c.user_id = $1 AND lt.id = $2`,
      [userId, taskId, reason]
    );
  }
}

module.exports = LinkedInService;
