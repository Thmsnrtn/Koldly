/**
 * Reply Response Drafting Service
 *
 * Autonomous pipeline step 4: categorize incoming replies → draft responses
 *
 * Categories:
 * - interested → Sonnet meeting draft
 * - objection → Sonnet counter/reframe
 * - ooo → Haiku auto-reschedule
 * - not_interested → Haiku polite close-out
 * - spam/bounce → skip
 */

const AIService = require('./ai-service');

class ReplyResponseService {
  constructor(pool) {
    this.pool = pool;
    this.ai = new AIService(pool);
  }

  /**
   * Categorize a reply email (Haiku — cheap, fast)
   */
  async categorizeReply(replyId, userId) {
    const reply = await this._getReply(replyId, userId);
    if (!reply) throw new Error('Reply not found');

    const result = await this.ai.callJSON('reply_categorization', {
      system: `You are a sales email categorization expert. Categorize this reply from a prospect.

Categories:
- "interested": They want to learn more, schedule a call, or are open to conversation
- "objection": They have concerns, pricing issues, timing issues, or push back but haven't said no
- "ooo": Out of office / auto-reply with a return date
- "not_interested": Clear decline, unsubscribe request, or hard no
- "spam": Irrelevant, automated marketing, or bounced email
- "question": They have a specific question but haven't indicated interest or disinterest

Return JSON: {
  "category": "string",
  "confidence": number (0-1),
  "reasoning": "string",
  "ooo_return_date": "string or null (ISO date if OOO)",
  "key_objection": "string or null (if objection, what is it)",
  "sentiment": "positive|neutral|negative"
}`,
      messages: [{
        role: 'user',
        content: `From: ${reply.sender_email}\nSubject: ${reply.subject}\n\n${reply.body_text || reply.body_html || ''}`
      }]
    }, { userId });

    const categorization = result.content;

    // Update reply record with category
    await this.pool.query(
      'UPDATE prospect_reply_inbox SET category = $1, ai_categorization = $2 WHERE id = $3',
      [categorization.category, JSON.stringify(categorization), replyId]
    );

    return categorization;
  }

  /**
   * Draft a response based on reply category
   */
  async draftResponse(replyId, userId) {
    const reply = await this._getReply(replyId, userId);
    if (!reply) throw new Error('Reply not found');

    // Get or compute categorization
    let category = reply.category;
    if (!category) {
      const categorization = await this.categorizeReply(replyId, userId);
      category = categorization.category;
    }

    // Skip spam/bounce
    if (category === 'spam') {
      return { skipped: true, reason: 'spam/bounce' };
    }

    // Route to appropriate drafter
    switch (category) {
      case 'interested':
        return this._draftInterestedResponse(reply, userId);
      case 'objection':
        return this._draftObjectionResponse(reply, userId);
      case 'ooo':
        return this._draftOOOResponse(reply, userId);
      case 'not_interested':
        return this._draftCloseOut(reply, userId);
      case 'question':
        return this._draftQuestionResponse(reply, userId);
      default:
        return this._draftInterestedResponse(reply, userId);
    }
  }

  /**
   * Process all uncategorized/undrafted replies for a user
   */
  async processNewReplies(userId) {
    // Get replies without drafts
    const repliesResult = await this.pool.query(`
      SELECT pri.id
      FROM prospect_reply_inbox pri
      JOIN campaigns c ON pri.campaign_id = c.id
      WHERE c.user_id = $1
        AND pri.category IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM reply_drafts rd WHERE rd.reply_id = pri.id
        )
      ORDER BY pri.received_at DESC
      LIMIT 20
    `, [userId]);

    const results = [];
    for (const row of repliesResult.rows) {
      try {
        // Categorize
        const categorization = await this.categorizeReply(row.id, userId);
        // Draft response
        const draft = await this.draftResponse(row.id, userId);
        results.push({ reply_id: row.id, category: categorization.category, draft });
      } catch (err) {
        console.error(`[ReplyResponse] Failed for reply #${row.id}:`, err.message);
        results.push({ reply_id: row.id, error: err.message });
      }
    }

    return { processed: results.length, results };
  }

  // ---- Category-specific drafters ----

  async _draftInterestedResponse(reply, userId) {
    const context = await this._getConversationContext(reply);

    const result = await this.ai.callJSON('reply_draft_interested', {
      system: `You are an expert SDR. The prospect has shown interest. Draft a warm, concise response that:
1. Acknowledges what they said specifically
2. Proposes 2-3 specific time slots for a call (use relative dates like "this Thursday" or "next Tuesday")
3. Keeps it under 80 words
4. Sounds human and enthusiastic but not overly eager

Return JSON: {
  "subject": "string",
  "body": "string",
  "suggested_action": "schedule_meeting"
}`,
      messages: [{
        role: 'user',
        content: `Their reply:\nFrom: ${reply.sender_email}\nSubject: ${reply.subject}\nBody: ${reply.body_text || ''}\n\nOriginal outreach context:\n${context}`
      }]
    }, { userId });

    return this._saveDraft(reply, result.content, 'interested', result.model);
  }

  async _draftObjectionResponse(reply, userId) {
    const context = await this._getConversationContext(reply);
    const categorization = reply.ai_categorization ? JSON.parse(reply.ai_categorization) : {};

    const result = await this.ai.callJSON('reply_draft_objection', {
      system: `You are an expert SDR handling an objection. Draft a response that:
1. Validates their concern — don't dismiss it
2. Reframes with a specific counter-point or case study reference
3. Asks one follow-up question to keep the conversation going
4. Under 100 words
5. No pressure tactics

${categorization.key_objection ? `Their main objection: "${categorization.key_objection}"` : ''}

Return JSON: {
  "subject": "string",
  "body": "string",
  "suggested_action": "follow_up"
}`,
      messages: [{
        role: 'user',
        content: `Their reply:\nFrom: ${reply.sender_email}\nSubject: ${reply.subject}\nBody: ${reply.body_text || ''}\n\nOriginal outreach context:\n${context}`
      }]
    }, { userId });

    return this._saveDraft(reply, result.content, 'objection', result.model);
  }

  async _draftOOOResponse(reply, userId) {
    const categorization = reply.ai_categorization ? JSON.parse(reply.ai_categorization) : {};

    const result = await this.ai.callJSON('ooo_scheduling', {
      system: `The prospect is out of office. Create a brief note to follow up after their return.

Return JSON: {
  "subject": "string",
  "body": "string (short, 2-3 sentences, reference their return)",
  "follow_up_date": "string (ISO date — their return date + 1 day, or 7 days from now if unknown)",
  "suggested_action": "schedule_follow_up"
}`,
      messages: [{
        role: 'user',
        content: `OOO reply: ${reply.body_text || reply.subject}\nReturn date: ${categorization.ooo_return_date || 'unknown'}`
      }]
    }, { userId });

    return this._saveDraft(reply, result.content, 'ooo', result.model);
  }

  async _draftCloseOut(reply, userId) {
    const result = await this.ai.callJSON('close_out_draft', {
      system: `The prospect has said no. Write a brief, graceful close-out that:
1. Thanks them for their time
2. Leaves the door open without being pushy
3. Under 40 words

Return JSON: {
  "subject": "string",
  "body": "string",
  "suggested_action": "close"
}`,
      messages: [{
        role: 'user',
        content: `Their reply: ${reply.body_text || reply.subject}`
      }]
    }, { userId });

    return this._saveDraft(reply, result.content, 'not_interested', result.model);
  }

  async _draftQuestionResponse(reply, userId) {
    const context = await this._getConversationContext(reply);

    const result = await this.ai.callJSON('reply_draft_interested', {
      system: `The prospect has asked a question. Draft a helpful response that:
1. Directly answers their question
2. Ties the answer back to value for them
3. Includes a soft CTA to continue the conversation
4. Under 100 words

Return JSON: {
  "subject": "string",
  "body": "string",
  "suggested_action": "follow_up"
}`,
      messages: [{
        role: 'user',
        content: `Their question:\nFrom: ${reply.sender_email}\nSubject: ${reply.subject}\nBody: ${reply.body_text || ''}\n\nOriginal outreach context:\n${context}`
      }]
    }, { userId });

    return this._saveDraft(reply, result.content, 'question', result.model);
  }

  // ---- Helpers ----

  async _saveDraft(reply, draft, category, modelUsed) {
    const insertResult = await this.pool.query(`
      INSERT INTO reply_drafts
        (reply_id, prospect_id, campaign_id, draft_subject, draft_body, reply_category, model_used, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval')
      RETURNING id
    `, [
      reply.id,
      reply.prospect_id,
      reply.campaign_id,
      draft.subject,
      draft.body,
      category,
      modelUsed
    ]);

    return {
      id: insertResult.rows[0].id,
      reply_id: reply.id,
      category,
      subject: draft.subject,
      body: draft.body,
      suggested_action: draft.suggested_action,
      follow_up_date: draft.follow_up_date || null,
      status: 'pending_approval'
    };
  }

  async _getReply(replyId, userId) {
    const result = await this.pool.query(`
      SELECT pri.*, c.user_id, c.description
      FROM prospect_reply_inbox pri
      JOIN campaigns c ON pri.campaign_id = c.id
      WHERE pri.id = $1 AND c.user_id = $2
    `, [replyId, userId]);
    return result.rows[0] || null;
  }

  async _getConversationContext(reply) {
    // Get the original outreach email for context
    const emailResult = await this.pool.query(`
      SELECT ge.subject_line, ge.email_body, ge.personalization_notes,
             p.company_name, p.industry, c.description
      FROM generated_emails ge
      JOIN prospects p ON ge.prospect_id = p.id
      JOIN campaigns c ON ge.campaign_id = c.id
      WHERE ge.prospect_id = $1
      ORDER BY ge.created_at DESC
      LIMIT 1
    `, [reply.prospect_id]);

    if (emailResult.rows.length === 0) return 'No prior context available.';

    const orig = emailResult.rows[0];
    return `Company: ${orig.company_name}\nIndustry: ${orig.industry}\nOur product: ${orig.description}\nOriginal subject: ${orig.subject_line}\nOriginal email: ${orig.email_body}`;
  }
}

module.exports = ReplyResponseService;
