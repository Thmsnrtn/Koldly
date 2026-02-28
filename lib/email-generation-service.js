/**
 * Email Generation Service
 *
 * Autonomous pipeline step 2: researched prospects → personalized email drafts
 * Uses Sonnet for quality email drafts. Stores as pending_approval for the queue.
 */

const AIService = require('./ai-service');

class EmailGenerationService {
  constructor(pool) {
    this.pool = pool;
    this.ai = new AIService(pool);
  }

  /**
   * Generate personalized emails for researched prospects in a campaign
   */
  async generateForCampaign(campaignId, userId, batchSize = 5) {
    const campaign = await this._getCampaign(campaignId, userId);
    if (!campaign) throw new Error('Campaign not found');

    const user = await this._getUser(userId);

    // Get researched prospects that don't have emails yet
    const prospectsResult = await this.pool.query(`
      SELECT p.*
      FROM prospects p
      WHERE p.campaign_id = $1
        AND p.status = 'researched'
        AND NOT EXISTS (
          SELECT 1 FROM generated_emails ge
          WHERE ge.prospect_id = p.id AND ge.status != 'rejected'
        )
      ORDER BY p.fit_score DESC
      LIMIT $2
    `, [campaignId, batchSize]);

    const prospects = prospectsResult.rows;
    if (prospects.length === 0) {
      return { generated: 0, emails: [] };
    }

    // Check budget
    const budget = await this.ai.checkBudget(userId);
    if (!budget.allowed) {
      throw new Error('AI budget exceeded for this billing period');
    }

    const generated = [];
    for (const prospect of prospects) {
      try {
        const email = await this._generateEmail(prospect, campaign, user);
        generated.push(email);
      } catch (err) {
        console.error(`[EmailGen] Failed for ${prospect.company_name}:`, err.message);
      }
    }

    return { generated: generated.length, emails: generated };
  }

  /**
   * Generate a single email for a specific prospect
   */
  async generateForProspect(prospectId, userId) {
    const prospectResult = await this.pool.query(
      'SELECT p.*, c.user_id FROM prospects p JOIN campaigns c ON p.campaign_id = c.id WHERE p.id = $1',
      [prospectId]
    );
    if (prospectResult.rows.length === 0) throw new Error('Prospect not found');

    const prospect = prospectResult.rows[0];
    if (prospect.user_id !== userId) throw new Error('Unauthorized');

    const campaign = await this._getCampaign(prospect.campaign_id, userId);
    const user = await this._getUser(userId);

    return this._generateEmail(prospect, campaign, user);
  }

  /**
   * Regenerate an email (rejected or needs revision)
   */
  async regenerateEmail(emailId, userId, feedback = '') {
    const emailResult = await this.pool.query(`
      SELECT ge.*, c.user_id, c.description, c.icp_description, c.icp_structured,
             p.company_name, p.website, p.industry, p.location, p.estimated_size,
             p.pain_points, p.research_summary, p.ai_reasoning
      FROM generated_emails ge
      JOIN campaigns c ON ge.campaign_id = c.id
      JOIN prospects p ON ge.prospect_id = p.id
      WHERE ge.id = $1
    `, [emailId]);

    if (emailResult.rows.length === 0) throw new Error('Email not found');
    const email = emailResult.rows[0];
    if (email.user_id !== userId) throw new Error('Unauthorized');

    const user = await this._getUser(userId);

    const result = await this.ai.callJSON('email_draft', {
      system: `You are an elite cold email copywriter. Write a personalized cold email.
${feedback ? `The user rejected the previous draft with this feedback: "${feedback}". Improve accordingly.` : ''}

Rules:
- First line must be a personalized hook about THEIR company, not about you
- Under 120 words total
- One clear CTA (question, not a demand)
- No buzzwords, no hype, no "hope this finds you well"
- Sound like a real person, not a template
- Reference specific details about their company

Return JSON: {
  "subject": "string (under 60 chars, no spam words)",
  "body": "string (the full email body)",
  "personalization_notes": "string (what makes this email specific to them)"
}`,
      messages: [{
        role: 'user',
        content: `Prospect: ${email.company_name}
Industry: ${email.industry}
Size: ${email.estimated_size}
Pain Points: ${email.pain_points}
Research: ${email.research_summary || email.ai_reasoning || 'None'}

Our Product: ${email.description}
Sender: ${user.sender_name || user.name || 'the sender'}
${email.subject_line ? `Previous subject: ${email.subject_line}\nPrevious body: ${email.email_body}` : ''}`
      }]
    }, { userId });

    const draft = result.content;

    // Update the existing email
    await this.pool.query(`
      UPDATE generated_emails SET
        subject_line = $1,
        email_body = $2,
        personalization_notes = $3,
        status = 'pending_approval',
        updated_at = NOW()
      WHERE id = $4
    `, [draft.subject, draft.body, draft.personalization_notes, emailId]);

    return {
      id: emailId,
      subject: draft.subject,
      body: draft.body,
      personalization_notes: draft.personalization_notes,
      status: 'pending_approval'
    };
  }

  // ---- Internal ----

  async _generateEmail(prospect, campaign, user) {
    const result = await this.ai.callJSON('email_draft', {
      system: `You are an elite cold email copywriter. Write a personalized cold email.

Rules:
- First line must be a personalized hook about THEIR company, not about you
- Under 120 words total
- One clear CTA (question, not a demand)
- No buzzwords, no hype, no "hope this finds you well"
- Sound like a real person, not a template
- Reference specific details about their company

Return JSON: {
  "subject": "string (under 60 chars, no spam words)",
  "body": "string (the full email body)",
  "personalization_notes": "string (what makes this email specific to them)",
  "recipient_name": "string (best guess at decision maker name)",
  "recipient_email": "string (best guess at email, or empty)"
}`,
      messages: [{
        role: 'user',
        content: `Prospect: ${prospect.company_name}
Website: ${prospect.website || 'unknown'}
Industry: ${prospect.industry}
Size: ${prospect.estimated_size}
Location: ${prospect.location}
Pain Points: ${prospect.pain_points}
Research: ${prospect.research_summary || prospect.ai_reasoning || 'None'}

Our Product: ${campaign.description}
ICP: ${campaign.icp_description || JSON.stringify(campaign.icp_structured) || 'Not specified'}
Sender: ${user.sender_name || user.name || 'the sender'}`
      }]
    }, { userId: user.id });

    const draft = result.content;

    // Insert into generated_emails
    const insertResult = await this.pool.query(`
      INSERT INTO generated_emails
        (prospect_id, campaign_id, recipient_email, recipient_name, subject_line, email_body, personalization_notes, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval')
      RETURNING id
    `, [
      prospect.id,
      campaign.id,
      draft.recipient_email || null,
      draft.recipient_name || null,
      draft.subject,
      draft.body,
      draft.personalization_notes
    ]);

    // Update prospect status
    await this.pool.query(
      "UPDATE prospects SET status = 'email_drafted' WHERE id = $1",
      [prospect.id]
    );

    return {
      id: insertResult.rows[0].id,
      prospect_id: prospect.id,
      company_name: prospect.company_name,
      subject: draft.subject,
      body: draft.body,
      personalization_notes: draft.personalization_notes,
      status: 'pending_approval',
      ai_cost_cents: result.cost_cents
    };
  }

  async _getCampaign(campaignId, userId) {
    const result = await this.pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, userId]
    );
    return result.rows[0] || null;
  }

  async _getUser(userId) {
    const result = await this.pool.query(
      'SELECT id, name, email, sender_name, sender_email, product_description FROM users WHERE id = $1',
      [userId]
    );
    return result.rows[0] || {};
  }
}

module.exports = EmailGenerationService;
