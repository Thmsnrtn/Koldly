/**
 * Marketing Service
 *
 * Handles testimonial processing, Voice of Customer (VOC) tracking,
 * and positioning evolution recommendations.
 */

const AIService = require('./ai-service');
const DecisionQueueService = require('./decision-queue-service');

class MarketingService {
  constructor(pool) {
    this.pool = pool;
    this.ai = new AIService(pool);
    this.decisionQueue = new DecisionQueueService(pool);
  }

  /**
   * Process a user-submitted testimonial via AI
   */
  async processTestimonial(userId, content) {
    // Get user info
    const user = await this.pool.query(
      'SELECT email, name, subscription_plan FROM users WHERE id = $1',
      [userId]
    );
    const u = user.rows[0] || {};

    // AI extraction
    const analysis = await this.ai.callJSON('testimonial_analysis', {
      system: `Extract testimonial data. Return JSON: {
        "quote": "string (best 1-2 sentence excerpt)",
        "attribution": "string (name, title if known)",
        "use_case": "string (how they use Koldly)",
        "sentiment_score": number (1-10),
        "potential_placement": ["landing", "case_study", "social"]
      }`,
      messages: [{ role: 'user', content: `From: ${u.name || u.email || 'User'} (${u.subscription_plan || 'free'} plan)\n\nTestimonial:\n${content}` }]
    }, { userId });

    // Store as product signal
    await this.pool.query(`
      INSERT INTO product_signals (signal_type, source, user_id, content, ai_analysis, priority)
      VALUES ('testimonial', 'user_submitted', $1, $2, $3, 'medium')
    `, [userId, content, JSON.stringify(analysis.content)]);

    // Queue for admin review via Gate 3
    await this.decisionQueue.enqueue(
      `Testimonial from ${u.name || u.email}: "${(analysis.content.quote || content).substring(0, 60)}..."`,
      'marketing', 'low', 3,
      {
        action_type: 'testimonial_review',
        user_id: userId,
        content,
        analysis: analysis.content
      },
      'ai'
    );

    return analysis.content;
  }

  /**
   * Generate monthly VOC (Voice of Customer) report
   */
  async generateVOCReport() {
    console.log('[Marketing] Generating VOC report');

    // Aggregate feedback sources
    const feedback = await this.pool.query(`
      SELECT rating, what_worked, what_frustrated, missing_features, created_at
      FROM beta_feedback
      WHERE created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC
    `);

    const supportThemes = await this.pool.query(`
      SELECT category, COUNT(*) as count, AVG(ai_confidence) as avg_ai_confidence
      FROM support_tickets
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY category
      ORDER BY count DESC
    `);

    const featureRequests = await this.pool.query(`
      SELECT content, ai_analysis, priority
      FROM product_signals
      WHERE signal_type = 'feature_request' AND created_at >= NOW() - INTERVAL '30 days'
      ORDER BY priority, created_at DESC
      LIMIT 20
    `);

    const report = await this.ai.callJSON('voc_report', {
      system: `You are Koldly's VOC analyst. Synthesize customer feedback into positioning recommendations.

Return JSON: {
  "overall_sentiment": number (1-10),
  "top_pain_points": [],
  "top_value_props": [],
  "messaging_gaps": [],
  "positioning_recommendations": [],
  "feature_priority_from_voc": []
}`,
      messages: [{ role: 'user', content: `Beta Feedback (${feedback.rows.length} responses):\n${JSON.stringify(feedback.rows.slice(0, 30))}\n\nSupport Themes:\n${JSON.stringify(supportThemes.rows)}\n\nFeature Requests:\n${JSON.stringify(featureRequests.rows)}` }]
    }, { forceModel: 'sonnet', skipCache: true });

    // Store as product signal
    await this.pool.query(`
      INSERT INTO product_signals (signal_type, source, content, ai_analysis, priority)
      VALUES ('voc_insight', 'monthly_voc', $1, $2, 'high')
    `, [JSON.stringify({ feedback_count: feedback.rows.length }), JSON.stringify(report.content)]);

    console.log('[Marketing] VOC report generated');
    return report.content;
  }

  /**
   * Check if positioning should evolve based on accumulated VOC data.
   * Creates Gate 3 decision if changes recommended.
   */
  async checkPositioningEvolution() {
    // Get recent VOC insights
    const insights = await this.pool.query(`
      SELECT ai_analysis FROM product_signals
      WHERE signal_type = 'voc_insight' AND created_at >= NOW() - INTERVAL '60 days'
      ORDER BY created_at DESC
      LIMIT 3
    `);

    if (insights.rows.length === 0) return null;

    const latestAnalysis = typeof insights.rows[0].ai_analysis === 'string'
      ? JSON.parse(insights.rows[0].ai_analysis)
      : insights.rows[0].ai_analysis;

    // If recommendations exist, queue for approval
    if (latestAnalysis.positioning_recommendations && latestAnalysis.positioning_recommendations.length > 0) {
      await this.decisionQueue.enqueue(
        `Positioning evolution: ${latestAnalysis.positioning_recommendations.length} recommendations from VOC`,
        'marketing', 'medium', 3,
        {
          action_type: 'positioning_evolution',
          recommendations: latestAnalysis.positioning_recommendations,
          sentiment: latestAnalysis.overall_sentiment
        },
        'ai'
      );

      return latestAnalysis.positioning_recommendations;
    }

    return null;
  }
}

module.exports = MarketingService;
