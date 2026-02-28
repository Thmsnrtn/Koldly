/**
 * Support Service
 *
 * 4-tier support escalation:
 *   Tier 1 — Self-serve: Knowledge base search
 *   Tier 2 — AI Resolution: Claude (Haiku) attempts resolution using KB + user context
 *   Tier 3 — Async: Escalated tickets land in decision queue
 *   Tier 4 — Sync: P0 critical issues trigger Slack + immediate decision queue
 */

const AIService = require('./ai-service');
const DecisionQueueService = require('./decision-queue-service');

class SupportService {
  constructor(pool) {
    this.pool = pool;
    this.ai = new AIService(pool);
    this.decisionQueue = new DecisionQueueService(pool);
  }

  // ============================================
  // TIER 1: KNOWLEDGE BASE
  // ============================================

  /**
   * Search knowledge base by query string (keyword + array overlap)
   */
  async searchKB(query) {
    if (!query || query.trim().length < 2) return [];

    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);

    const result = await this.pool.query(`
      SELECT id, title, content, category, keywords,
        (
          -- Keyword array overlap score
          (SELECT COUNT(*) FROM unnest(keywords) kw WHERE LOWER(kw) = ANY($1::text[])) * 3 +
          -- Title match score
          CASE WHEN LOWER(title) LIKE $2 THEN 5 ELSE 0 END +
          -- Content match score
          CASE WHEN LOWER(content) LIKE $2 THEN 2 ELSE 0 END
        ) as relevance_score
      FROM knowledge_base
      WHERE
        LOWER(title) LIKE $2
        OR LOWER(content) LIKE $2
        OR keywords && $1::text[]
      ORDER BY relevance_score DESC
      LIMIT 5
    `, [terms, `%${terms[0]}%`]);

    // Increment view counts
    for (const row of result.rows) {
      this.pool.query('UPDATE knowledge_base SET view_count = view_count + 1 WHERE id = $1', [row.id]).catch(() => {});
    }

    return result.rows;
  }

  /**
   * List all KB articles by category
   */
  async listKB(category = null) {
    const query = category
      ? 'SELECT id, title, category, keywords, view_count FROM knowledge_base WHERE category = $1 ORDER BY view_count DESC'
      : 'SELECT id, title, category, keywords, view_count FROM knowledge_base ORDER BY category, view_count DESC';
    const params = category ? [category] : [];
    const result = await this.pool.query(query, params);
    return result.rows;
  }

  /**
   * Mark a KB article as helpful
   */
  async markHelpful(articleId) {
    await this.pool.query('UPDATE knowledge_base SET helpful_count = helpful_count + 1 WHERE id = $1', [articleId]);
  }

  // ============================================
  // TIER 2: AI RESOLUTION
  // ============================================

  /**
   * Create a support ticket and attempt AI resolution
   */
  async createTicket(userId, subject, description, priority = 'p2') {
    // Auto-categorize based on keywords
    const category = this._categorize(subject, description);

    // Insert ticket
    const ticketResult = await this.pool.query(`
      INSERT INTO support_tickets (user_id, subject, description, category, priority)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [userId, subject, description, category, priority]);

    const ticket = ticketResult.rows[0];

    // P0: Skip AI, escalate immediately (Tier 4)
    if (priority === 'p0') {
      return this._escalateP0(ticket);
    }

    // Attempt AI resolution
    try {
      const resolution = await this._attemptAIResolution(ticket, userId);

      if (resolution.confidence >= 0.8 && !resolution.needs_escalation) {
        // Tier 2: AI resolved with high confidence
        await this.pool.query(`
          UPDATE support_tickets SET
            status = 'ai_resolved',
            ai_resolution = $1,
            ai_confidence = $2,
            resolution_method = 'ai',
            resolved_at = NOW()
          WHERE id = $3
        `, [resolution.resolution, resolution.confidence, ticket.id]);

        // Log via Gate 1
        await this.decisionQueue.enqueue(
          `Support AI resolved: "${subject}"`,
          'support', 'low', 1,
          { action_type: 'support_ai_resolution', ticket_id: ticket.id, confidence: resolution.confidence },
          'ai'
        );

        return { ...ticket, status: 'ai_resolved', ai_resolution: resolution.resolution, resolution_method: 'ai' };
      }

      // Low confidence or escalation needed: move to Tier 3
      return this._escalateToAsync(ticket, resolution);
    } catch (err) {
      console.error(`[Support] AI resolution failed for ticket #${ticket.id}:`, err.message);
      return this._escalateToAsync(ticket, { resolution: null, confidence: 0, needs_escalation: true, escalation_reason: 'AI resolution failed' });
    }
  }

  /**
   * Attempt AI resolution using KB context + user context
   */
  async _attemptAIResolution(ticket, userId) {
    // Get relevant KB articles
    const kbArticles = await this.searchKB(ticket.subject + ' ' + (ticket.description || ''));
    const kbContext = kbArticles.map(a => `[${a.title}]: ${a.content}`).join('\n\n');

    // Get user context
    const userContext = await this._getUserContext(userId);

    const result = await this.ai.callJSON('support_resolution', {
      system: `You are Koldly's support assistant. Resolve this ticket using the knowledge base and user context.

Knowledge Base:
${kbContext || '(no matching articles)'}

User Context:
${JSON.stringify(userContext)}

Return JSON: { "resolution": "string", "confidence": number (0-1), "matched_kb_articles": [], "needs_escalation": boolean, "escalation_reason": "string or null" }`,
      messages: [{ role: 'user', content: `Subject: ${ticket.subject}\nDescription: ${ticket.description || '(none)'}` }]
    }, { userId });

    return result.content;
  }

  // ============================================
  // TIER 3: ASYNC ESCALATION
  // ============================================

  async _escalateToAsync(ticket, resolution) {
    const urgency = ticket.priority === 'p1' ? 'high' : 'medium';

    const decision = await this.decisionQueue.enqueue(
      `Support ticket #${ticket.id}: ${ticket.subject}`,
      'support', urgency, 3,
      {
        action_type: 'support_escalation',
        ticket_id: ticket.id,
        user_id: ticket.user_id,
        subject: ticket.subject,
        description: ticket.description,
        ai_attempted: !!resolution.resolution,
        ai_confidence: resolution.confidence,
        escalation_reason: resolution.escalation_reason || 'Low AI confidence'
      },
      'system'
    );

    await this.pool.query(`
      UPDATE support_tickets SET
        status = 'escalated',
        ai_resolution = $1,
        ai_confidence = $2,
        decision_queue_id = $3
      WHERE id = $4
    `, [resolution.resolution, resolution.confidence, decision.id, ticket.id]);

    return { ...ticket, status: 'escalated', decision_queue_id: decision.id };
  }

  // ============================================
  // TIER 4: SYNC / P0 CRITICAL
  // ============================================

  async _escalateP0(ticket) {
    const decision = await this.decisionQueue.enqueue(
      `🚨 P0 CRITICAL: ${ticket.subject}`,
      'support', 'critical', 3,
      {
        action_type: 'support_p0',
        ticket_id: ticket.id,
        user_id: ticket.user_id,
        subject: ticket.subject,
        description: ticket.description
      },
      'system'
    );

    await this.pool.query(`
      UPDATE support_tickets SET status = 'escalated', decision_queue_id = $1 WHERE id = $2
    `, [decision.id, ticket.id]);

    // Attempt Slack notification
    try {
      const SlackService = require('./slack-service');
      const slack = new SlackService(this.pool);
      // Get admin user for slack notification
      const admin = await this.pool.query('SELECT id FROM users WHERE is_admin = true LIMIT 1');
      if (admin.rows.length > 0) {
        await slack.sendNotification(admin.rows[0].id, 'support.p0', {
          ticket_id: ticket.id,
          subject: ticket.subject,
          description: ticket.description
        });
      }
    } catch (slackErr) {
      console.error('[Support] Slack P0 notification failed:', slackErr.message);
    }

    return { ...ticket, status: 'escalated', decision_queue_id: decision.id };
  }

  // ============================================
  // ADMIN OPERATIONS
  // ============================================

  /**
   * Get all tickets with optional filters
   */
  async getTickets(filters = {}) {
    const { status, priority, limit = 50, offset = 0 } = filters;
    let where = 'WHERE 1=1';
    const params = [];

    if (status) {
      params.push(status);
      where += ` AND st.status = $${params.length}`;
    }
    if (priority) {
      params.push(priority);
      where += ` AND st.priority = $${params.length}`;
    }

    params.push(limit, offset);
    const result = await this.pool.query(`
      SELECT st.*, u.email as user_email, u.name as user_name
      FROM support_tickets st
      LEFT JOIN users u ON st.user_id = u.id
      ${where}
      ORDER BY
        CASE st.priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p3' THEN 3 END,
        st.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    return result.rows;
  }

  /**
   * Resolve a ticket manually
   */
  async resolveTicket(ticketId, resolution, resolvedBy = 'admin') {
    const result = await this.pool.query(`
      UPDATE support_tickets SET
        status = 'closed',
        resolution_notes = $1,
        resolution_method = 'async',
        resolved_at = NOW(),
        updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [resolution, ticketId]);

    if (result.rows.length === 0) throw new Error('Ticket not found');
    return result.rows[0];
  }

  /**
   * Re-attempt AI resolution on open tickets (called by scheduler)
   */
  async retriageOpenTickets() {
    const openTickets = await this.pool.query(`
      SELECT st.* FROM support_tickets st
      WHERE st.status = 'open' AND st.created_at >= NOW() - INTERVAL '7 days'
      LIMIT 10
    `);

    let resolved = 0;
    for (const ticket of openTickets.rows) {
      try {
        const resolution = await this._attemptAIResolution(ticket, ticket.user_id);
        if (resolution.confidence >= 0.85) {
          await this.pool.query(`
            UPDATE support_tickets SET
              status = 'ai_resolved', ai_resolution = $1, ai_confidence = $2,
              resolution_method = 'ai', resolved_at = NOW()
            WHERE id = $3
          `, [resolution.resolution, resolution.confidence, ticket.id]);
          resolved++;
        }
      } catch {
        // Skip failed retriage
      }
    }

    return { checked: openTickets.rows.length, resolved };
  }

  // ============================================
  // HELPERS
  // ============================================

  _categorize(subject, description) {
    const text = (subject + ' ' + (description || '')).toLowerCase();
    if (text.includes('billing') || text.includes('payment') || text.includes('invoice') || text.includes('plan')) return 'billing';
    if (text.includes('email') || text.includes('sending') || text.includes('deliverability') || text.includes('bounce')) return 'deliverability';
    if (text.includes('csv') || text.includes('import') || text.includes('prospect')) return 'prospects';
    if (text.includes('campaign') || text.includes('approval') || text.includes('queue')) return 'campaigns';
    if (text.includes('integration') || text.includes('slack') || text.includes('webhook')) return 'integrations';
    if (text.includes('login') || text.includes('password') || text.includes('account')) return 'account';
    return 'general';
  }

  async _getUserContext(userId) {
    try {
      const user = await this.pool.query(`
        SELECT u.email, u.name, u.subscription_plan, u.onboarding_completed, u.activated_at, u.created_at,
               (SELECT COUNT(*) FROM campaigns WHERE user_id = u.id) as campaign_count,
               (SELECT COUNT(*) FROM campaign_sending_queue csq JOIN campaigns c ON csq.campaign_id = c.id WHERE c.user_id = u.id AND csq.status = 'sent') as emails_sent
        FROM users u WHERE u.id = $1
      `, [userId]);

      return user.rows[0] || {};
    } catch {
      return {};
    }
  }
}

module.exports = SupportService;
