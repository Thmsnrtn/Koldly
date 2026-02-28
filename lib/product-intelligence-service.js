/**
 * Product Intelligence Service
 *
 * A/B testing infrastructure, product signal ingestion, and automated report generation.
 * Reports use Claude (Sonnet) for analysis and are stored in operator_digest.
 */

const crypto = require('crypto');
const AIService = require('./ai-service');

class ProductIntelligenceService {
  constructor(pool) {
    this.pool = pool;
    this.ai = new AIService(pool);
  }

  // ============================================
  // A/B TESTING
  // ============================================

  /**
   * Create a new A/B experiment
   */
  async createExperiment(name, target, variants, description = '', sampleSizeTarget = 100) {
    const result = await this.pool.query(`
      INSERT INTO ab_experiments (name, description, target, variants, sample_size_target)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name, description, target, JSON.stringify(variants), sampleSizeTarget]);
    return result.rows[0];
  }

  /**
   * Start an experiment (set status to running)
   */
  async startExperiment(experimentId) {
    const result = await this.pool.query(`
      UPDATE ab_experiments SET status = 'running', start_date = NOW()
      WHERE id = $1 AND status = 'draft'
      RETURNING *
    `, [experimentId]);
    if (result.rows.length === 0) throw new Error('Experiment not found or not in draft status');
    return result.rows[0];
  }

  /**
   * Deterministic variant assignment (hash of userId/sessionId + experimentId)
   */
  async assignVariant(experimentId, userId = null, sessionId = null) {
    if (!userId && !sessionId) throw new Error('Either userId or sessionId required');

    // Check existing assignment
    const existing = userId
      ? await this.pool.query('SELECT variant FROM ab_assignments WHERE experiment_id = $1 AND user_id = $2', [experimentId, userId])
      : await this.pool.query('SELECT variant FROM ab_assignments WHERE experiment_id = $1 AND session_id = $2', [experimentId, sessionId]);

    if (existing.rows.length > 0) return existing.rows[0].variant;

    // Get experiment
    const exp = await this.pool.query('SELECT * FROM ab_experiments WHERE id = $1 AND status = $2', [experimentId, 'running']);
    if (exp.rows.length === 0) return null;

    const variants = typeof exp.rows[0].variants === 'string' ? JSON.parse(exp.rows[0].variants) : exp.rows[0].variants;
    if (!variants || variants.length === 0) return null;

    // Deterministic assignment via hash
    const hashInput = `${experimentId}-${userId || sessionId}`;
    const hash = crypto.createHash('md5').update(hashInput).digest('hex');
    const index = parseInt(hash.substring(0, 8), 16) % variants.length;
    const variant = typeof variants[index] === 'object' ? variants[index].name : variants[index];

    // Record assignment
    try {
      await this.pool.query(`
        INSERT INTO ab_assignments (experiment_id, user_id, session_id, variant)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
      `, [experimentId, userId, sessionId, variant]);
    } catch {
      // Ignore duplicate assignment errors
    }

    return variant;
  }

  /**
   * Record a conversion event for an experiment
   */
  async recordConversion(experimentId, userId = null, sessionId = null, conversionEvent = 'default') {
    const where = userId
      ? 'experiment_id = $1 AND user_id = $2'
      : 'experiment_id = $1 AND session_id = $2';
    const params = [experimentId, userId || sessionId, conversionEvent];

    await this.pool.query(`
      UPDATE ab_assignments SET converted = true, conversion_event = $3, converted_at = NOW()
      WHERE ${where} AND converted = false
    `, params);
  }

  /**
   * Evaluate experiment results with statistical significance (Z-test)
   */
  async evaluateExperiment(experimentId) {
    const exp = await this.pool.query('SELECT * FROM ab_experiments WHERE id = $1', [experimentId]);
    if (exp.rows.length === 0) throw new Error('Experiment not found');

    const results = await this.pool.query(`
      SELECT
        variant,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE converted = true) as conversions,
        ROUND(100.0 * COUNT(*) FILTER (WHERE converted = true) / NULLIF(COUNT(*), 0), 2) as conversion_rate
      FROM ab_assignments
      WHERE experiment_id = $1
      GROUP BY variant
      ORDER BY conversion_rate DESC
    `, [experimentId]);

    const variantResults = results.rows;

    // Statistical significance check (Z-test for two proportions)
    let significant = false;
    let winner = null;

    if (variantResults.length >= 2) {
      const a = variantResults[0];
      const b = variantResults[1];
      const n1 = parseInt(a.total);
      const n2 = parseInt(b.total);
      const p1 = parseInt(a.conversions) / n1;
      const p2 = parseInt(b.conversions) / n2;
      const pPool = (parseInt(a.conversions) + parseInt(b.conversions)) / (n1 + n2);
      const se = Math.sqrt(pPool * (1 - pPool) * (1/n1 + 1/n2));

      if (se > 0) {
        const z = Math.abs(p1 - p2) / se;
        significant = z >= 1.96; // p < 0.05
        if (significant) winner = a.variant;
      }
    }

    return {
      experiment: exp.rows[0],
      variants: variantResults,
      significant,
      winner,
      total_assignments: variantResults.reduce((sum, v) => sum + parseInt(v.total), 0)
    };
  }

  /**
   * Conclude experiment and record winner
   */
  async concludeExperiment(experimentId, winningVariant = null) {
    const evaluation = await this.evaluateExperiment(experimentId);
    const winner = winningVariant || evaluation.winner;

    await this.pool.query(`
      UPDATE ab_experiments SET status = 'concluded', winning_variant = $1, end_date = NOW()
      WHERE id = $2
    `, [winner, experimentId]);

    return { ...evaluation, concluded: true, winning_variant: winner };
  }

  /**
   * List experiments with optional status filter
   */
  async listExperiments(status = null) {
    const query = status
      ? 'SELECT * FROM ab_experiments WHERE status = $1 ORDER BY created_at DESC'
      : 'SELECT * FROM ab_experiments ORDER BY created_at DESC';
    const params = status ? [status] : [];
    const result = await this.pool.query(query, params);
    return result.rows;
  }

  // ============================================
  // PRODUCT SIGNAL INGESTION
  // ============================================

  /**
   * Ingest a product signal and run AI analysis
   */
  async ingestSignal(signalType, source, content, userId = null) {
    // Store signal
    const result = await this.pool.query(`
      INSERT INTO product_signals (signal_type, source, user_id, content)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [signalType, source, userId, content]);

    const signal = result.rows[0];

    // Run AI analysis (Haiku for speed)
    try {
      const analysis = await this.ai.callJSON('signal_analysis', {
        system: `Analyze this product signal and categorize it. Return JSON: { "summary": "string", "priority": "critical|high|medium|low", "category": "string", "actionable": boolean, "suggested_action": "string or null" }`,
        messages: [{ role: 'user', content: `Signal type: ${signalType}\nSource: ${source}\nContent: ${content}` }]
      });

      await this.pool.query(
        'UPDATE product_signals SET ai_analysis = $1, priority = $2 WHERE id = $3',
        [JSON.stringify(analysis.content), analysis.content.priority || 'medium', signal.id]
      );

      return { ...signal, ai_analysis: analysis.content };
    } catch (err) {
      console.error('[ProductIntel] Signal analysis failed:', err.message);
      return signal;
    }
  }

  /**
   * Get product signals with optional filters
   */
  async getSignals(filters = {}) {
    const { signalType, status, limit = 50 } = filters;
    let where = 'WHERE 1=1';
    const params = [];

    if (signalType) { params.push(signalType); where += ` AND signal_type = $${params.length}`; }
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }

    params.push(limit);
    const result = await this.pool.query(`
      SELECT ps.*, u.email as user_email
      FROM product_signals ps
      LEFT JOIN users u ON ps.user_id = u.id
      ${where}
      ORDER BY ps.created_at DESC
      LIMIT $${params.length}
    `, params);

    return result.rows;
  }

  // ============================================
  // REPORT GENERATION (Claude Sonnet)
  // ============================================

  /**
   * Generate weekly product signal report
   */
  async generateWeeklyProductReport() {
    console.log('[ProductIntel] Generating weekly product report');

    // Gather signals from the past week
    const signals = await this.pool.query(`
      SELECT signal_type, content, ai_analysis, priority, created_at
      FROM product_signals
      WHERE created_at >= NOW() - INTERVAL '7 days'
      ORDER BY priority, created_at DESC
    `);

    // Gather usage metrics
    const usage = await this.pool.query(`
      SELECT event_type, COUNT(*) as count
      FROM analytics_events
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY event_type
      ORDER BY count DESC
    `);

    const report = await this.ai.callJSON('weekly_product_report', {
      system: `You are Koldly's product intelligence analyst. Analyze the following weekly data and produce actionable insights.

Return JSON: { "key_themes": [], "feature_requests_ranked": [], "churn_risk_patterns": [], "expansion_opportunities": [], "recommended_actions": [{ "action": "string", "priority": "string", "rationale": "string" }] }`,
      messages: [{ role: 'user', content: `Weekly Signals (${signals.rows.length}):\n${JSON.stringify(signals.rows.slice(0, 50))}\n\nUsage Metrics:\n${JSON.stringify(usage.rows)}` }]
    }, { forceModel: 'sonnet', skipCache: true });

    // Store in operator_digest
    await this.pool.query(`
      INSERT INTO operator_digest (digest_type, content) VALUES ('weekly', $1)
    `, [JSON.stringify({ report: report.content, generated_at: new Date().toISOString(), signals_analyzed: signals.rows.length })]);

    console.log('[ProductIntel] Weekly report generated');
    return report.content;
  }

  /**
   * Generate monthly marketing review
   */
  async generateMonthlyMarketingReview() {
    console.log('[ProductIntel] Generating monthly marketing review');

    // Gather testimonials
    const testimonials = await this.pool.query(`
      SELECT content, ai_analysis FROM product_signals
      WHERE signal_type = 'testimonial' AND created_at >= NOW() - INTERVAL '30 days'
    `);

    // Conversion metrics
    const conversions = await this.pool.query(`
      SELECT event_type, COUNT(DISTINCT user_id) as unique_users
      FROM analytics_events
      WHERE event_type IN ('signup', 'onboarding_completed', 'first_email_approved', 'billing_checkout')
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY event_type
    `);

    const report = await this.ai.callJSON('monthly_marketing_review', {
      system: `You are Koldly's marketing strategist. Review the data and recommend messaging and positioning updates.

Return JSON: { "positioning_score": number, "messaging_recommendations": [], "testimonial_highlights": [], "landing_page_suggestions": [], "email_template_suggestions": [] }`,
      messages: [{ role: 'user', content: `Testimonials:\n${JSON.stringify(testimonials.rows)}\n\nConversion Metrics:\n${JSON.stringify(conversions.rows)}` }]
    }, { forceModel: 'sonnet', skipCache: true });

    await this.pool.query(
      "INSERT INTO operator_digest (digest_type, content) VALUES ('monthly', $1)",
      [JSON.stringify({ report: report.content, generated_at: new Date().toISOString() })]
    );

    console.log('[ProductIntel] Monthly marketing review generated');
    return report.content;
  }

  /**
   * Generate quarterly pricing/strategic review
   */
  async generateQuarterlyReview() {
    console.log('[ProductIntel] Generating quarterly strategic review');

    // Comprehensive metrics
    const metrics = await this.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '90 days') as new_users_90d,
        (SELECT COUNT(*) FROM users WHERE activated_at IS NOT NULL) as activated_users,
        (SELECT COUNT(DISTINCT user_id) FROM analytics_events WHERE event_type = 'billing_checkout') as paying_users,
        (SELECT COUNT(*) FROM campaigns) as total_campaigns,
        (SELECT COUNT(*) FROM campaign_sending_queue WHERE status = 'sent') as total_emails_sent,
        (SELECT COUNT(*) FROM prospect_reply_inbox) as total_replies
    `);

    // Churn data
    const churn = await this.pool.query(`
      SELECT churn_risk, COUNT(*) as count
      FROM engagement_scores
      GROUP BY churn_risk
    `);

    const report = await this.ai.callJSON('quarterly_strategic_review', {
      system: `You are Koldly's strategic advisor. Conduct a quarterly business review.

Return JSON: { "health_score": number (1-10), "revenue_analysis": {}, "pricing_recommendations": [], "product_priorities": [], "risk_factors": [], "opportunities": [], "90_day_plan": [] }`,
      messages: [{ role: 'user', content: `Quarterly Metrics:\n${JSON.stringify(metrics.rows[0])}\n\nChurn Distribution:\n${JSON.stringify(churn.rows)}` }]
    }, { forceModel: 'sonnet', skipCache: true });

    await this.pool.query(
      "INSERT INTO operator_digest (digest_type, content) VALUES ('quarterly', $1)",
      [JSON.stringify({ report: report.content, generated_at: new Date().toISOString() })]
    );

    console.log('[ProductIntel] Quarterly review generated');
    return report.content;
  }
}

module.exports = ProductIntelligenceService;
