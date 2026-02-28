/**
 * Unified AI Platform Layer
 *
 * Single entry point for ALL AI calls. Handles:
 * - Model routing (Haiku default, Sonnet for quality-critical)
 * - Input-hash response caching (Postgres-backed)
 * - Token counting + cost tracking
 * - Structured JSON output enforcement
 * - Cheap-first escalation (Haiku → Sonnet on quality failure)
 * - Plan-tier budget enforcement
 */

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

// Model definitions with pricing (per million tokens)
const MODELS = {
  haiku: {
    id: 'claude-3-5-haiku-20241022',
    inputCostPerMTok: 0.25,
    outputCostPerMTok: 1.25,
    maxTokens: 8192
  },
  sonnet: {
    id: 'claude-sonnet-4-20250514',
    inputCostPerMTok: 3.0,
    outputCostPerMTok: 15.0,
    maxTokens: 8192
  }
};

// Task → model mapping (default assignments)
const TASK_MODEL_MAP = {
  // Haiku tasks (cheap, fast)
  'icp_parse': 'haiku',
  'prospect_discovery': 'haiku',
  'follow_up_generation': 'haiku',
  'reply_categorization': 'haiku',
  'ooo_scheduling': 'haiku',
  'data_extraction': 'haiku',
  'close_out_draft': 'haiku',

  // Sonnet tasks (quality-critical)
  'email_draft': 'sonnet',
  'prospect_research': 'sonnet',
  'reply_draft_interested': 'sonnet',
  'reply_draft_objection': 'sonnet',
  'proof_demo': 'sonnet',
  'recategorize': 'sonnet'
};

class AIService {
  constructor(pool) {
    this.pool = pool;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  /**
   * Main entry point for all AI calls
   *
   * @param {string} task - Task type (maps to model via TASK_MODEL_MAP)
   * @param {object} input - { system, messages, maxTokens, jsonSchema }
   * @param {object} options - { userId, skipCache, forceModel, cacheTtlSeconds }
   * @returns {object} { content, model, cached, tokens_in, tokens_out, cost_cents, latency_ms }
   */
  async call(task, input, options = {}) {
    const startTime = Date.now();
    const modelKey = options.forceModel || TASK_MODEL_MAP[task] || 'haiku';
    const model = MODELS[modelKey];

    if (!model) {
      throw new Error(`Unknown model: ${modelKey}`);
    }

    // Check cache first
    if (!options.skipCache) {
      const cached = await this._checkCache(task, input, modelKey);
      if (cached) {
        await this._trackUsage(options.userId, task, modelKey, cached.tokens_in, cached.tokens_out, true, 0, Date.now() - startTime);
        return {
          content: cached.response,
          model: modelKey,
          cached: true,
          tokens_in: cached.tokens_in,
          tokens_out: cached.tokens_out,
          cost_cents: 0,
          latency_ms: Date.now() - startTime
        };
      }
    }

    // Build messages array
    const messages = input.messages || [{ role: 'user', content: input.prompt || '' }];

    // Call Anthropic API
    const apiParams = {
      model: model.id,
      max_tokens: input.maxTokens || model.maxTokens,
      messages
    };

    if (input.system) {
      apiParams.system = input.system;
    }

    let response;
    try {
      // Add timeout via AbortController (30 seconds)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      try {
        response = await this.client.messages.create(apiParams, { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      // Handle timeout
      if (err.name === 'AbortError') {
        throw new Error(`AI request timed out after 30 seconds (task: ${task})`);
      }
      // If Haiku fails and task allows escalation, try Sonnet
      if (modelKey === 'haiku' && !options.forceModel && err.status !== 401) {
        console.warn(`[AI] Haiku failed for ${task}, escalating to Sonnet: ${err.message}`);
        return this.call(task, input, { ...options, forceModel: 'sonnet' });
      }
      throw err;
    }

    const content = response.content[0]?.text || '';
    const tokensIn = response.usage?.input_tokens || 0;
    const tokensOut = response.usage?.output_tokens || 0;

    // Calculate cost
    const costCents = ((tokensIn / 1_000_000) * model.inputCostPerMTok + (tokensOut / 1_000_000) * model.outputCostPerMTok) * 100;

    // Parse JSON if requested
    let parsed = content;
    if (input.jsonSchema) {
      try {
        // Extract JSON from response (handle markdown code blocks)
        let jsonStr = content;
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          jsonStr = jsonMatch[1].trim();
        }
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        // If JSON parse fails on Haiku, escalate to Sonnet
        if (modelKey === 'haiku' && !options.forceModel) {
          console.warn(`[AI] Haiku JSON parse failed for ${task}, escalating to Sonnet`);
          return this.call(task, input, { ...options, forceModel: 'sonnet' });
        }
        console.error(`[AI] JSON parse failed for ${task}:`, parseErr.message);
        parsed = content;
      }
    }

    const latencyMs = Date.now() - startTime;

    // Cache the result
    if (!options.skipCache) {
      const ttl = options.cacheTtlSeconds || this._getDefaultTtl(task);
      await this._setCache(task, input, modelKey, parsed, tokensIn, tokensOut, ttl);
    }

    // Track usage
    await this._trackUsage(options.userId, task, modelKey, tokensIn, tokensOut, false, costCents, latencyMs);

    return {
      content: parsed,
      model: modelKey,
      cached: false,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_cents: Math.round(costCents * 100) / 100,
      latency_ms: latencyMs
    };
  }

  /**
   * Convenience: call with JSON output expected
   */
  async callJSON(task, input, options = {}) {
    const systemSuffix = '\n\nRespond with valid JSON only. No markdown, no explanation, just the JSON object.';
    return this.call(task, {
      ...input,
      system: (input.system || '') + systemSuffix,
      jsonSchema: true
    }, options);
  }

  /**
   * Check budget for a user based on their plan tier
   */
  async checkBudget(userId) {
    try {
      const result = await this.pool.query(`
        SELECT
          u.subscription_plan,
          COALESCE(SUM(au.cost_cents), 0) as total_cost_cents
        FROM users u
        LEFT JOIN ai_usage au ON au.user_id = u.id
          AND au.created_at >= DATE_TRUNC('month', NOW())
        WHERE u.id = $1
        GROUP BY u.subscription_plan
      `, [userId]);

      if (result.rows.length === 0) return { allowed: true, remaining_cents: 1000 };

      const { subscription_plan, total_cost_cents } = result.rows[0];
      const budgets = {
        'starter': 1000,   // $10
        'growth': 5000,    // $50
        'scale': 20000,    // $200
        'free': 500        // $5 trial
      };

      const budget = budgets[subscription_plan] || budgets.free;
      const remaining = budget - parseInt(total_cost_cents);

      return {
        allowed: remaining > 0,
        remaining_cents: Math.max(remaining, 0),
        budget_cents: budget,
        used_cents: parseInt(total_cost_cents),
        plan: subscription_plan || 'free'
      };
    } catch (err) {
      console.error('[AI] Budget check failed:', err.message);
      // Fail closed — deny on error to prevent runaway costs
      return { allowed: false, remaining_cents: 0, error: 'Budget check failed' };
    }
  }

  /**
   * Get AI usage stats for admin dashboard
   */
  async getUsageStats(period = '7d') {
    try {
      const intervals = { '24h': '1 day', '7d': '7 days', '30d': '30 days' };
      const interval = intervals[period] || '7 days';

      const result = await this.pool.query(`
        SELECT
          task_type,
          model,
          COUNT(*) as call_count,
          SUM(tokens_in) as total_tokens_in,
          SUM(tokens_out) as total_tokens_out,
          SUM(cost_cents) as total_cost_cents,
          AVG(latency_ms)::int as avg_latency_ms,
          SUM(CASE WHEN cached THEN 1 ELSE 0 END) as cache_hits,
          ROUND(100.0 * SUM(CASE WHEN cached THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as cache_hit_rate
        FROM ai_usage
        WHERE created_at >= NOW() - $1::interval
        GROUP BY task_type, model
        ORDER BY total_cost_cents DESC
      `, [interval]);

      return result.rows;
    } catch (err) {
      console.error('[AI] Usage stats failed:', err.message);
      return [];
    }
  }

  // ---- Internal methods ----

  _generateCacheKey(task, input, modelKey) {
    const hashInput = JSON.stringify({
      task,
      model: modelKey,
      system: input.system || '',
      messages: input.messages || input.prompt || ''
    });
    return crypto.createHash('sha256').update(hashInput).digest('hex');
  }

  async _checkCache(task, input, modelKey) {
    try {
      const hash = this._generateCacheKey(task, input, modelKey);
      const result = await this.pool.query(
        `SELECT response, tokens_in, tokens_out FROM ai_cache
         WHERE hash = $1 AND expires_at > NOW()`,
        [hash]
      );
      if (result.rows.length > 0) {
        return result.rows[0];
      }
      return null;
    } catch (err) {
      // Cache miss on error — non-fatal
      return null;
    }
  }

  async _setCache(task, input, modelKey, response, tokensIn, tokensOut, ttlSeconds) {
    try {
      const hash = this._generateCacheKey(task, input, modelKey);
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      await this.pool.query(
        `INSERT INTO ai_cache (hash, model, task_type, response, tokens_in, tokens_out, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (hash) DO UPDATE SET response = $4, tokens_in = $5, tokens_out = $6, expires_at = $7`,
        [hash, modelKey, task, JSON.stringify(response), tokensIn, tokensOut, expiresAt]
      );
    } catch (err) {
      console.error('[AI] Cache write failed:', err.message);
    }
  }

  async _trackUsage(userId, task, model, tokensIn, tokensOut, cached, costCents, latencyMs) {
    try {
      await this.pool.query(
        `INSERT INTO ai_usage (user_id, task_type, model, tokens_in, tokens_out, cached, cost_cents, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId || null, task, model, tokensIn, tokensOut, cached, Math.round(costCents * 100) / 100, latencyMs]
      );
    } catch (err) {
      console.error('[AI] Usage tracking failed:', err.message);
    }
  }

  _getDefaultTtl(task) {
    const ttls = {
      'icp_parse': 86400,           // 24h
      'prospect_discovery': 86400,   // 24h
      'prospect_research': 604800,   // 7d
      'email_draft': 604800,         // 7d
      'follow_up_generation': 86400, // 24h
      'reply_categorization': 3600,  // 1h
      'reply_draft_interested': 3600,
      'reply_draft_objection': 3600,
      'close_out_draft': 3600,
      'proof_demo': 3600,
      'ooo_scheduling': 3600,
      'data_extraction': 86400,
      'recategorize': 3600
    };
    return ttls[task] || 3600;
  }
}

module.exports = AIService;
