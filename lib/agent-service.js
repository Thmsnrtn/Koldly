/**
 * Multi-Agent Orchestration Service (Tier 3)
 *
 * Runs multi-step AI agent workflows as DAGs (Directed Acyclic Graphs).
 * Each node is an AI agent with typed inputs and outputs.
 * Human checkpoints are routed through the DecisionQueueService.
 *
 * Built-in workflow: Campaign Architect
 *   1. ResearchAgent  — market intelligence, buying signals, tech stack
 *   2. CopywriterAgent — 5 email variants with distinct angles
 *   3. CriticAgent    — scores and rejects low-quality variants
 *   4. [Human gate]   — user reviews and selects preferred variants
 *   5. OptimizerAgent — (post-send) analyzes performance, revises brief
 *
 * Workflow state is persisted in agent_workflows table so it survives
 * restarts and can be resumed at any node.
 */

// ============================================================
// DAG Node types
// ============================================================

const NODE_TYPES = {
  RESEARCH: 'research',
  COPYWRITER: 'copywriter',
  CRITIC: 'critic',
  OPTIMIZER: 'optimizer',
  HUMAN_GATE: 'human_gate',
  EMAIL_DEPLOY: 'email_deploy'
};

// ============================================================
// Individual Agent implementations
// ============================================================

async function runResearchAgent(ai, userId, context) {
  const { icp, campaignDescription, prospectCompany } = context;

  const result = await ai.callJSON('agent_research', {
    system: `You are a B2B market research agent. Research the target market and identify buying signals.
You have access to publicly available knowledge about companies and industries.

Return JSON: {
  "market_summary": "string (2-3 paragraphs on the ICP's current challenges and priorities)",
  "buying_signals": ["string (specific signals this ICP is actively evaluating solutions)"],
  "tech_stack_patterns": ["string (common tools/platforms this ICP uses)"],
  "competitive_landscape": ["string (alternatives they might already use)"],
  "best_timing_signals": ["string (triggers that indicate a good time to reach out)"],
  "recommended_angles": [
    {
      "angle": "string (angle name)",
      "hypothesis": "string (why this angle resonates with this ICP)",
      "hook": "string (the opening line this angle would use)"
    }
  ]
}`,
    messages: [{
      role: 'user',
      content: [
        `ICP: ${JSON.stringify(icp)}`,
        `Product/service: ${campaignDescription}`,
        prospectCompany ? `Specific company: ${prospectCompany}` : ''
      ].filter(Boolean).join('\n')
    }]
  }, { userId, forceModel: 'sonnet' });

  return result.content;
}

async function runCopywriterAgent(ai, userId, context) {
  const { researchOutput, campaignDescription, senderName, icp } = context;

  const ANGLES = [
    'ROI / cost savings — quantify the financial benefit',
    'Pain / frustration — lead with a specific pain point they experience',
    'Social proof — reference a similar company\'s result',
    'Provocative question — challenge an assumption they hold',
    'Timely / trigger — reference a recent event or trend'
  ];

  const result = await ai.callJSON('agent_copywriter', {
    system: `You are a B2B email copywriter. Write 5 cold email variants, each using a distinct angle.
Each email should be:
- 100-150 words max (mobile-first reading)
- Hyper-specific — NOT generic
- Genuinely personalized based on the ICP research
- One clear CTA: a 15-min call or a specific question

Angles to use (one per email):
${ANGLES.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Return JSON: {
  "variants": [
    {
      "angle": "string (which angle this uses)",
      "subject": "string (email subject line, max 50 chars)",
      "body": "string (full email body)",
      "word_count": number,
      "personalization_score": number (1-10, how specific this is to the ICP)
    }
  ]
}`,
    messages: [{
      role: 'user',
      content: [
        `Product: ${campaignDescription}`,
        `Sender: ${senderName}`,
        `ICP: ${JSON.stringify(icp)}`,
        `Market research:\n${JSON.stringify(researchOutput, null, 2)}`
      ].join('\n\n')
    }]
  }, { userId, forceModel: 'sonnet', skipCache: true });

  return result.content;
}

async function runCriticAgent(ai, userId, context) {
  const { variants } = context;

  const result = await ai.callJSON('agent_critic', {
    system: `You are a critical B2B email reviewer. Score each email variant on these criteria:
1. Personalization (1-10): How specific is this to the ICP? Generic = 1, highly specific = 10
2. Spam risk (1-10): Would this trigger spam filters or feel spammy? Low risk = 1, high risk = 10
3. CTA clarity (1-10): Is the ask clear and low-friction? Confusing = 1, crystal clear = 10
4. Length (1-10): Is the length appropriate? Too long/short = 1, just right = 10

Reject any variant scoring below 6 on personalization or above 7 on spam risk.

Return JSON: {
  "scored_variants": [
    {
      "angle": "string",
      "personalization": number,
      "spam_risk": number,
      "cta_clarity": number,
      "length": number,
      "overall": number (average of all scores),
      "passed": boolean,
      "rejection_reason": "string or null"
    }
  ],
  "recommendation": "string (which variant(s) to test first and why)"
}`,
    messages: [{
      role: 'user',
      content: `Email variants to review:\n${JSON.stringify(variants, null, 2)}`
    }]
  }, { userId, forceModel: 'haiku' });

  return result.content;
}

async function runOptimizerAgent(ai, userId, context) {
  const { variants, performanceData, campaignDescription, icp } = context;

  const result = await ai.callJSON('agent_optimizer', {
    system: `You are a B2B email performance analyst. Review the A/B test results and recommend improvements.
Be specific: cite which elements drove performance differences and propose concrete changes.

Return JSON: {
  "winner_analysis": "string (why the winning variant outperformed)",
  "failure_analysis": "string (why underperforming variants failed)",
  "revised_brief": {
    "angle_recommendation": "string",
    "subject_recommendations": ["string"],
    "body_recommendations": ["string"],
    "avoid": ["string (elements to avoid based on data)"]
  },
  "next_test_hypothesis": "string (what to test next and why)"
}`,
    messages: [{
      role: 'user',
      content: [
        `Campaign: ${campaignDescription}`,
        `ICP: ${JSON.stringify(icp)}`,
        `Variants tested: ${JSON.stringify(variants)}`,
        `Performance data: ${JSON.stringify(performanceData)}`
      ].join('\n\n')
    }]
  }, { userId, forceModel: 'sonnet' });

  return result.content;
}

// ============================================================
// AgentService
// ============================================================

class AgentService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Start a Campaign Architect workflow for a campaign.
   * Runs Research → Copywriter → Critic → Human Gate.
   *
   * @returns {object} { workflow_id, status, current_node, output }
   */
  async startCampaignArchitect(campaignId, userId, ai) {
    const campaign = await this.pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, userId]
    );
    if (campaign.rows.length === 0) throw new Error('Campaign not found');
    const c = campaign.rows[0];

    // Create workflow record
    const workflowResult = await this.pool.query(
      `INSERT INTO agent_workflows
       (campaign_id, user_id, workflow_type, status, current_node, input_context)
       VALUES ($1, $2, 'campaign_architect', 'running', 'research', $3)
       RETURNING id`,
      [campaignId, userId, JSON.stringify({ campaign_id: campaignId })]
    );
    const workflowId = workflowResult.rows[0].id;

    // Run workflow asynchronously (don't block the API response)
    this._runCampaignArchitectAsync(workflowId, c, userId, ai)
      .catch(err => {
        console.error(`[Agent] Campaign Architect workflow ${workflowId} failed:`, err.message);
        this.pool.query(
          `UPDATE agent_workflows SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [err.message.slice(0, 500), workflowId]
        ).catch(() => {});
      });

    return {
      workflow_id: workflowId,
      status: 'running',
      current_node: 'research',
      message: 'Campaign Architect is researching your market. Check back in 2–3 minutes.'
    };
  }

  async _runCampaignArchitectAsync(workflowId, campaign, userId, ai) {
    const updateNode = (node, nodeOutput) => this.pool.query(
      `UPDATE agent_workflows
       SET current_node = $1, node_outputs = node_outputs || $2::jsonb, updated_at = NOW()
       WHERE id = $3`,
      [node, JSON.stringify({ [node]: nodeOutput }), workflowId]
    );

    // --- Node 1: Research ---
    console.info(`[Agent] Workflow ${workflowId}: Research node`);
    const icp = campaign.icp_structured || {};
    const researchOutput = await runResearchAgent(ai, userId, {
      icp, campaignDescription: campaign.description
    });
    await updateNode('copywriter', { research: researchOutput });

    // --- Node 2: Copywriter ---
    console.info(`[Agent] Workflow ${workflowId}: Copywriter node`);
    const copywriterOutput = await runCopywriterAgent(ai, userId, {
      researchOutput, campaignDescription: campaign.description, icp,
      senderName: campaign.sender_name || 'the sender'
    });
    await updateNode('critic', { copywriter: copywriterOutput });

    // --- Node 3: Critic ---
    console.info(`[Agent] Workflow ${workflowId}: Critic node`);
    const criticOutput = await runCriticAgent(ai, userId, {
      variants: copywriterOutput.variants || []
    });
    await updateNode('human_gate', { critic: criticOutput });

    // Filter to passing variants
    const passingVariants = (criticOutput.scored_variants || [])
      .filter(v => v.passed)
      .map(sv => {
        const original = (copywriterOutput.variants || []).find(v => v.angle === sv.angle);
        return { ...original, scores: sv };
      });

    // --- Node 4: Human Gate ---
    // Store result and pause for human review
    await this.pool.query(
      `UPDATE agent_workflows
       SET status = 'awaiting_human',
           current_node = 'human_gate',
           node_outputs = node_outputs || $1::jsonb,
           final_output = $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [
        JSON.stringify({ human_gate: { awaiting: true, timestamp: new Date().toISOString() } }),
        JSON.stringify({
          passing_variants: passingVariants,
          all_variants: copywriterOutput.variants,
          critic_scores: criticOutput.scored_variants,
          recommendation: criticOutput.recommendation,
          research_summary: researchOutput.market_summary,
          recommended_angles: researchOutput.recommended_angles
        }),
        workflowId
      ]
    );

    console.info(`[Agent] Workflow ${workflowId}: Paused at human gate with ${passingVariants.length} passing variants`);
  }

  /**
   * Run the Optimizer agent after a campaign has send data.
   * Called manually or by scheduler after 14+ days of campaign data.
   */
  async runOptimizer(workflowId, userId, ai, performanceData) {
    const workflowResult = await this.pool.query(
      `SELECT * FROM agent_workflows WHERE id = $1 AND user_id = $2`,
      [workflowId, userId]
    );
    if (workflowResult.rows.length === 0) throw new Error('Workflow not found');
    const workflow = workflowResult.rows[0];

    const finalOutput = workflow.final_output || {};
    const variants = finalOutput.passing_variants || finalOutput.all_variants || [];

    const optimizerOutput = await runOptimizerAgent(ai, userId, {
      variants, performanceData,
      campaignDescription: workflow.input_context?.campaign_description || '',
      icp: workflow.input_context?.icp || {}
    });

    await this.pool.query(
      `UPDATE agent_workflows
       SET status = 'optimizer_complete',
           current_node = 'complete',
           node_outputs = node_outputs || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify({ optimizer: optimizerOutput }), workflowId]
    );

    return optimizerOutput;
  }

  /**
   * Resume a workflow after human gate (user selected preferred variants).
   */
  async resumeAfterHumanGate(workflowId, userId, selectedVariantAngles) {
    await this.pool.query(
      `UPDATE agent_workflows
       SET status = 'completed',
           current_node = 'complete',
           node_outputs = node_outputs || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 AND user_id = $3 AND status = 'awaiting_human'`,
      [JSON.stringify({ human_selection: { selected: selectedVariantAngles, at: new Date().toISOString() } }), workflowId, userId]
    );

    return { workflow_id: workflowId, status: 'completed', selected_variants: selectedVariantAngles };
  }

  /**
   * Get workflow status and output.
   */
  async getWorkflow(workflowId, userId) {
    const result = await this.pool.query(
      `SELECT * FROM agent_workflows WHERE id = $1 AND user_id = $2`,
      [workflowId, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * List all workflows for a user (optionally filtered by campaign).
   */
  async listWorkflows(userId, campaignId = null) {
    const params = [userId];
    let where = 'WHERE aw.user_id = $1';
    if (campaignId) {
      where += ' AND aw.campaign_id = $2';
      params.push(campaignId);
    }

    const result = await this.pool.query(
      `SELECT aw.id, aw.campaign_id, aw.workflow_type, aw.status, aw.current_node,
              aw.created_at, aw.updated_at, c.name as campaign_name
       FROM agent_workflows aw
       LEFT JOIN campaigns c ON c.id = aw.campaign_id
       ${where}
       ORDER BY aw.created_at DESC LIMIT 20`,
      params
    );

    return result.rows;
  }
}

module.exports = AgentService;
