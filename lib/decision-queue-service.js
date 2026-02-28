/**
 * Decision Queue & Safety Gate Service
 *
 * Central hub for all automated actions that need oversight.
 * Safety Gates:
 *   Gate 0 — Auto-execute, log only (analytics, cache, reports)
 *   Gate 1 — Auto-execute, notify admin (scheduled emails, routine nudges)
 *   Gate 2 — Execute after 1hr delay, admin can cancel (churn interventions, upgrade prompts)
 *   Gate 3 — Require human approval (pricing changes, marketing copy, new programs)
 *   Gate 4 — Require human approval + confirmation (bulk sends >100, billing changes, data deletion)
 */

class DecisionQueueService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Enqueue a decision. Auto-executes Gate 0-1, schedules Gate 2, queues Gate 3-4.
   * @returns {object} The created decision with its resolution status
   */
  async enqueue(title, category, urgency, safetyGate, proposedAction, createdBy = 'system') {
    const expiresAt = this._getExpiry(urgency);
    const scheduledFor = safetyGate === 2 ? new Date(Date.now() + 60 * 60 * 1000) : null; // 1hr delay for Gate 2

    const status = safetyGate <= 1 ? 'auto_executed' : safetyGate === 2 ? 'scheduled' : 'pending';

    const result = await this.pool.query(`
      INSERT INTO decision_queue (title, category, urgency, safety_gate, status, proposed_action, created_by, scheduled_for, expires_at, resolved_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      title, category, urgency, safetyGate, status,
      JSON.stringify(proposedAction), createdBy,
      scheduledFor, expiresAt,
      status === 'auto_executed' ? new Date() : null
    ]);

    const decision = result.rows[0];

    // Log the safety gate action
    await this._logGate(proposedAction.action_type || title, safetyGate, decision.id, proposedAction, null, status === 'auto_executed');

    // Gate 0-1: Auto-execute immediately
    if (safetyGate <= 1) {
      console.log(`[DecisionQueue] Gate ${safetyGate} auto-executed: ${title}`);
    }

    // Gate 2: Log scheduled execution
    if (safetyGate === 2) {
      console.log(`[DecisionQueue] Gate 2 scheduled for 1hr: ${title}`);
    }

    // Gate 3-4: Log pending
    if (safetyGate >= 3) {
      console.log(`[DecisionQueue] Gate ${safetyGate} queued for approval: ${title}`);
    }

    return decision;
  }

  /**
   * Resolve a pending/scheduled decision (approve or reject)
   */
  async resolve(decisionId, status, outcome = null, resolvedBy = 'admin') {
    if (!['approved', 'rejected'].includes(status)) {
      throw new Error('Status must be "approved" or "rejected"');
    }

    const result = await this.pool.query(`
      UPDATE decision_queue
      SET status = $1, outcome = $2, resolved_by = $3, resolved_at = NOW()
      WHERE id = $4 AND status IN ('pending', 'scheduled')
      RETURNING *
    `, [status, outcome ? JSON.stringify(outcome) : null, resolvedBy, decisionId]);

    if (result.rows.length === 0) {
      throw new Error('Decision not found or already resolved');
    }

    const decision = result.rows[0];
    await this._logGate(
      decision.title, decision.safety_gate, decisionId,
      decision.proposed_action, outcome, status === 'approved'
    );

    return decision;
  }

  /**
   * Get pending decisions with optional filters
   */
  async getPending(filters = {}) {
    const { category, urgency, safetyGate, limit = 50, offset = 0 } = filters;

    let where = "WHERE status IN ('pending', 'scheduled')";
    const params = [];

    if (category) {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }
    if (urgency) {
      params.push(urgency);
      where += ` AND urgency = $${params.length}`;
    }
    if (safetyGate !== undefined) {
      params.push(safetyGate);
      where += ` AND safety_gate = $${params.length}`;
    }

    params.push(limit, offset);
    const result = await this.pool.query(`
      SELECT * FROM decision_queue
      ${where}
      ORDER BY
        CASE urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        created_at ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    const countResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM decision_queue ${where}`,
      params.slice(0, -2)
    );

    return {
      decisions: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit,
      offset
    };
  }

  /**
   * Execute scheduled Gate 2 decisions that have passed their delay
   */
  async executeScheduled() {
    const result = await this.pool.query(`
      UPDATE decision_queue
      SET status = 'auto_executed', resolved_at = NOW(), resolved_by = 'system_scheduler'
      WHERE status = 'scheduled' AND scheduled_for <= NOW()
      RETURNING *
    `);

    for (const decision of result.rows) {
      console.log(`[DecisionQueue] Gate 2 auto-executed after delay: ${decision.title}`);
      await this._logGate(
        decision.title, 2, decision.id,
        decision.proposed_action, null, true
      );
    }

    return result.rows;
  }

  /**
   * Expire stale decisions past their expires_at
   */
  async autoExpire() {
    const result = await this.pool.query(`
      UPDATE decision_queue
      SET status = 'expired', resolved_at = NOW()
      WHERE status IN ('pending', 'scheduled') AND expires_at < NOW()
      RETURNING id, title
    `);

    if (result.rows.length > 0) {
      console.log(`[DecisionQueue] Expired ${result.rows.length} stale decisions`);
    }

    return result.rows;
  }

  /**
   * Generate a digest for a given period (weekly/monthly/quarterly)
   */
  async getDigest(period = 'weekly') {
    const intervals = { weekly: '7 days', monthly: '30 days', quarterly: '90 days' };
    const interval = intervals[period] || '7 days';

    const stats = await this.pool.query(`
      SELECT
        status,
        category,
        COUNT(*) as count
      FROM decision_queue
      WHERE created_at >= NOW() - $1::interval
      GROUP BY status, category
      ORDER BY count DESC
    `, [interval]);

    const recentDecisions = await this.pool.query(`
      SELECT id, title, category, urgency, status, safety_gate, created_at, resolved_at
      FROM decision_queue
      WHERE created_at >= NOW() - $1::interval
      ORDER BY
        CASE urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        created_at DESC
      LIMIT 20
    `, [interval]);

    // Summary counts
    const summary = {
      total: 0,
      auto_executed: 0,
      approved: 0,
      rejected: 0,
      pending: 0,
      expired: 0,
      by_category: {}
    };

    for (const row of stats.rows) {
      const count = parseInt(row.count);
      summary.total += count;
      summary[row.status] = (summary[row.status] || 0) + count;
      if (!summary.by_category[row.category]) summary.by_category[row.category] = 0;
      summary.by_category[row.category] += count;
    }

    return {
      period,
      interval,
      summary,
      recent_decisions: recentDecisions.rows
    };
  }

  /**
   * Get counts by status for dashboard display
   */
  async getCounts() {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('pending', 'scheduled')) as pending,
        COUNT(*) FILTER (WHERE status = 'pending' AND urgency = 'critical') as critical,
        COUNT(*) FILTER (WHERE status = 'auto_executed' AND created_at >= NOW() - INTERVAL '24 hours') as auto_executed_24h,
        COUNT(*) FILTER (WHERE status = 'approved' AND resolved_at >= NOW() - INTERVAL '24 hours') as approved_24h
      FROM decision_queue
    `);
    return result.rows[0];
  }

  // --- Internal helpers ---

  _getExpiry(urgency) {
    const expiryDays = { critical: 1, high: 3, medium: 7, low: 14 };
    const days = expiryDays[urgency] || 7;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  async _logGate(actionType, gateLevel, decisionQueueId, inputData, outputData, autoApproved) {
    try {
      await this.pool.query(`
        INSERT INTO safety_gate_log (action_type, gate_level, decision_queue_id, input_data, output_data, auto_approved)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [actionType, gateLevel, decisionQueueId, JSON.stringify(inputData || {}), JSON.stringify(outputData || {}), autoApproved]);
    } catch (err) {
      console.error('[DecisionQueue] Gate log failed:', err.message);
    }
  }
}

module.exports = DecisionQueueService;
