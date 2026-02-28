/**
 * Prospect Discovery Service
 *
 * Autonomous pipeline step 1: ICP → discover prospects → research
 * Uses Haiku for discovery (cheap, high-volume) and Sonnet for research (quality-critical).
 */

const AIService = require('./ai-service');

class ProspectDiscoveryService {
  constructor(pool) {
    this.pool = pool;
    this.ai = new AIService(pool);
  }

  /**
   * Parse a free-text ICP description into structured fields (Haiku)
   */
  async parseICP(icpText, userId) {
    const result = await this.ai.callJSON('icp_parse', {
      system: `You are an ICP (Ideal Customer Profile) analyst. Parse the user's description into structured fields.
Return JSON: {
  "industries": ["string"],
  "company_sizes": ["string"],
  "job_titles": ["string"],
  "geographies": ["string"],
  "pain_points": ["string"],
  "keywords": ["string"],
  "funding_stages": ["string"],
  "summary": "one-sentence summary"
}`,
      messages: [{ role: 'user', content: icpText }]
    }, { userId });

    return result.content;
  }

  /**
   * Discover prospects matching an ICP (Haiku, batched)
   * IMPORTANT: These are AI-GENERATED prospect profiles, not real company data.
   * They should be treated as brainstorming/preview — users must verify before sending.
   * For real prospect data, use CSV import or a future Apollo.io integration.
   */
  async discoverProspects(campaignId, userId, batchSize = 25) {
    const campaign = await this._getCampaign(campaignId, userId);
    if (!campaign) throw new Error('Campaign not found');

    // Check budget
    const budget = await this.ai.checkBudget(userId);
    if (!budget.allowed) {
      throw new Error('AI budget exceeded for this billing period');
    }

    // Check entitlements
    const entitlements = await this._getEntitlements(userId);
    const existingCount = await this._getProspectCount(campaignId);
    const remaining = entitlements.prospects_per_month - existingCount;
    if (remaining <= 0) {
      throw new Error(`Prospect limit reached (${entitlements.prospects_per_month}/month on ${entitlements.plan} plan)`);
    }
    const actualBatch = Math.min(batchSize, remaining);

    const icp = campaign.icp_structured || await this.parseICP(campaign.icp_description || campaign.description, userId);

    // Save structured ICP if not already saved
    if (!campaign.icp_structured && icp) {
      await this.pool.query(
        'UPDATE campaigns SET icp_structured = $1 WHERE id = $2',
        [JSON.stringify(icp), campaignId]
      );
    }

    // Update discovery status
    await this.pool.query(
      "UPDATE campaigns SET discovery_status = 'in_progress' WHERE id = $1",
      [campaignId]
    );

    const result = await this.ai.callJSON('prospect_discovery', {
      system: `You are a B2B prospect researcher. Generate ${actualBatch} hypothetical prospect company profiles that match the given ICP.
IMPORTANT: These are AI-generated examples for brainstorming purposes. They are NOT real companies.
For each prospect, provide detailed and plausible information. Each prospect should be unique.

Return JSON: {
  "prospects": [
    {
      "company_name": "string",
      "website": "string (plausible domain)",
      "industry": "string",
      "location": "string (city, state/country)",
      "estimated_size": "string (e.g. 50-200 employees)",
      "team_size": "string",
      "funding_stage": "string (e.g. Series A, bootstrapped)",
      "pain_points": "string (2-3 sentences)",
      "relevance_score": number (1-100),
      "reasoning": "string (why this company is a good fit)"
    }
  ]
}`,
      messages: [{
        role: 'user',
        content: `ICP: ${JSON.stringify(icp)}\n\nProduct/Service: ${campaign.description || 'Not specified'}\n\nGenerate ${actualBatch} prospect companies.`
      }]
    }, { userId });

    const prospects = result.content?.prospects || [];

    // Insert prospects into DB
    const insertedProspects = [];
    for (const p of prospects) {
      try {
        const insertResult = await this.pool.query(
          `INSERT INTO prospects
           (campaign_id, company_name, website, industry, location, estimated_size, team_size, funding_stage, pain_points, relevance_score, status, fit_score, ai_reasoning)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'discovered', $11, $12)
           RETURNING id`,
          [
            campaignId,
            p.company_name,
            p.website || null,
            p.industry || null,
            p.location || null,
            p.estimated_size || null,
            p.team_size || null,
            p.funding_stage || null,
            p.pain_points || null,
            p.relevance_score || 50,
            p.relevance_score || 50,
            p.reasoning || null
          ]
        );
        insertedProspects.push({ ...p, id: insertResult.rows[0].id });
      } catch (err) {
        console.error(`[Discovery] Failed to insert prospect ${p.company_name}:`, err.message);
      }
    }

    // Update discovery status
    await this.pool.query(
      "UPDATE campaigns SET discovery_status = 'completed' WHERE id = $1",
      [campaignId]
    );

    return {
      campaign_id: campaignId,
      prospects_discovered: insertedProspects.length,
      prospects: insertedProspects,
      ai_cost_cents: result.cost_cents
    };
  }

  /**
   * Generate deep research for a batch of prospects (Sonnet, quality-critical)
   */
  async researchProspects(campaignId, userId, prospectIds = null, batchSize = 5) {
    const campaign = await this._getCampaign(campaignId, userId);
    if (!campaign) throw new Error('Campaign not found');

    // Get prospects needing research
    let query = `
      SELECT id, company_name, website, industry, location, estimated_size, pain_points
      FROM prospects
      WHERE campaign_id = $1 AND status = 'discovered'
    `;
    const params = [campaignId];

    if (prospectIds && prospectIds.length > 0) {
      query += ' AND id = ANY($2)';
      params.push(prospectIds);
    }
    query += ` LIMIT ${batchSize}`;

    const prospectsResult = await this.pool.query(query, params);
    const prospects = prospectsResult.rows;

    if (prospects.length === 0) {
      return { researched: 0, prospects: [] };
    }

    const researched = [];
    for (const prospect of prospects) {
      try {
        const result = await this.ai.callJSON('prospect_research', {
          system: `You are a B2B sales researcher. Generate detailed research notes for a prospect company.
Include: key decision makers, recent news/events, technology stack hints, potential pain points specific to their situation, and recommended email angle.

Return JSON: {
  "decision_makers": [{"name": "string", "title": "string", "email_guess": "string"}],
  "recent_events": ["string"],
  "tech_indicators": ["string"],
  "specific_pain_points": ["string"],
  "recommended_angle": "string",
  "research_summary": "string (2-3 paragraphs)"
}`,
          messages: [{
            role: 'user',
            content: `Company: ${prospect.company_name}\nWebsite: ${prospect.website || 'unknown'}\nIndustry: ${prospect.industry}\nSize: ${prospect.estimated_size}\nLocation: ${prospect.location}\nKnown pain points: ${prospect.pain_points}\n\nOur product: ${campaign.description}`
          }]
        }, { userId });

        const research = result.content;

        // Update prospect with research
        await this.pool.query(
          `UPDATE prospects SET
            research_summary = $1,
            status = 'researched',
            fit_score = $2,
            ai_reasoning = $3
          WHERE id = $4`,
          [
            research.research_summary || JSON.stringify(research),
            prospect.relevance_score || 50,
            research.recommended_angle || null,
            prospect.id
          ]
        );

        // If we got decision maker info, set recipient details
        if (research.decision_makers && research.decision_makers.length > 0) {
          const dm = research.decision_makers[0];
          if (dm.email_guess) {
            await this.pool.query(
              'UPDATE prospects SET linkedin_url = $1 WHERE id = $2',
              [dm.title || null, prospect.id]
            );
          }
        }

        researched.push({ id: prospect.id, company: prospect.company_name, research });
      } catch (err) {
        console.error(`[Research] Failed for ${prospect.company_name}:`, err.message);
      }
    }

    return { researched: researched.length, prospects: researched };
  }

  // ---- Internal helpers ----

  async _getCampaign(campaignId, userId) {
    const result = await this.pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, userId]
    );
    return result.rows[0] || null;
  }

  async _getProspectCount(campaignId) {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM prospects
       WHERE campaign_id = $1
       AND created_at >= DATE_TRUNC('month', NOW())`,
      [campaignId]
    );
    return parseInt(result.rows[0].count);
  }

  async _getEntitlements(userId) {
    const result = await this.pool.query(`
      SELECT pe.*
      FROM users u
      JOIN plan_entitlements pe ON pe.plan = COALESCE(u.subscription_plan, 'free')
      WHERE u.id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      return { plan: 'free', prospects_per_month: 25, max_campaigns: 1, ai_budget_cents: 500 };
    }
    return result.rows[0];
  }
}

module.exports = ProspectDiscoveryService;
