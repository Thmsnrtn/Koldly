module.exports = {
  name: 'add_autonomous_operations',
  up: async (client) => {
    // ============================================
    // DECISION QUEUE & SAFETY GATES
    // ============================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS decision_queue (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(50) NOT NULL CHECK (category IN ('revenue', 'product', 'marketing', 'support', 'strategic', 'acquisition', 'retention', 'onboarding')),
        urgency VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (urgency IN ('critical', 'high', 'medium', 'low')),
        status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'auto_executed', 'expired', 'scheduled')),
        safety_gate INTEGER NOT NULL DEFAULT 2 CHECK (safety_gate >= 0 AND safety_gate <= 4),
        proposed_action JSONB,
        outcome JSONB,
        created_by VARCHAR(20) NOT NULL DEFAULT 'system' CHECK (created_by IN ('system', 'ai', 'user')),
        resolved_by VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        scheduled_for TIMESTAMPTZ,
        expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_decision_queue_status_urgency ON decision_queue (status, urgency);
      CREATE INDEX IF NOT EXISTS idx_decision_queue_category ON decision_queue (category);
      CREATE INDEX IF NOT EXISTS idx_decision_queue_scheduled ON decision_queue (scheduled_for) WHERE status = 'scheduled';
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS safety_gate_log (
        id SERIAL PRIMARY KEY,
        action_type VARCHAR(100) NOT NULL,
        gate_level INTEGER NOT NULL,
        decision_queue_id INTEGER REFERENCES decision_queue(id),
        input_data JSONB,
        output_data JSONB,
        auto_approved BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ============================================
    // ACQUISITION PROGRAMS
    // ============================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS acquisition_programs (
        id SERIAL PRIMARY KEY,
        program_name VARCHAR(50) NOT NULL UNIQUE CHECK (program_name IN ('acreos_acquisition', 'apex_micro_acquisition', 'koldly_self_acquisition')),
        target_product VARCHAR(100) NOT NULL,
        config JSONB DEFAULT '{}',
        status VARCHAR(20) DEFAULT 'inactive' CHECK (status IN ('active', 'inactive', 'paused')),
        isolation_key VARCHAR(50) NOT NULL UNIQUE,
        total_campaigns INTEGER DEFAULT 0,
        total_prospects INTEGER DEFAULT 0,
        total_emails_sent INTEGER DEFAULT 0,
        total_replies INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add isolation_key to campaigns table for program isolation
    await client.query(`
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS isolation_key VARCHAR(50);
      CREATE INDEX IF NOT EXISTS idx_campaigns_isolation ON campaigns (isolation_key) WHERE isolation_key IS NOT NULL;
    `);

    // Seed acquisition programs
    await client.query(`
      INSERT INTO acquisition_programs (program_name, target_product, isolation_key, config) VALUES
        ('acreos_acquisition', 'AcreOS', 'acreos', '{"icp": "Real estate professionals and property managers needing operational software", "description": "AI-powered cold outreach to acquire users for AcreOS property management platform"}'),
        ('apex_micro_acquisition', 'Apex Micro', 'apex_micro', '{"icp": "Small business owners and solopreneurs needing micro-tools", "description": "AI-powered cold outreach to acquire users for Apex Micro business tools"}'),
        ('koldly_self_acquisition', 'Koldly', 'koldly_self', '{"icp": "SaaS founders, agencies, and SDR managers doing manual cold outreach", "description": "Koldly dogfoods itself — AI-powered cold outreach to acquire Koldly users"}')
      ON CONFLICT (program_name) DO NOTHING
    `);

    // ============================================
    // ENGAGEMENT SCORING & RETENTION
    // ============================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS engagement_scores (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
        components JSONB DEFAULT '{}',
        churn_risk VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (churn_risk IN ('low', 'medium', 'high', 'critical')),
        last_calculated_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_engagement_scores_churn ON engagement_scores (churn_risk);
      CREATE INDEX IF NOT EXISTS idx_engagement_scores_score ON engagement_scores (score);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS retention_actions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        action_type VARCHAR(50) NOT NULL CHECK (action_type IN ('nudge_email', 'upgrade_prompt', 'win_back', 'habit_reinforcement', 'expansion_prompt', 'testimonial_request', 'dunning_day0', 'dunning_day3', 'dunning_day7', 'dunning_day14', 'stuck_csv_nudge', 'stuck_approval_nudge', 'stuck_sender_nudge', 'reengagement')),
        trigger_reason TEXT,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'cancelled', 'failed')),
        metadata JSONB DEFAULT '{}',
        decision_queue_id INTEGER REFERENCES decision_queue(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        executed_at TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_retention_actions_user ON retention_actions (user_id, action_type);
      CREATE INDEX IF NOT EXISTS idx_retention_actions_status ON retention_actions (status) WHERE status = 'pending';
    `);

    // ============================================
    // SUPPORT SYSTEM
    // ============================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        subject VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(50) DEFAULT 'general',
        priority VARCHAR(10) DEFAULT 'p2' CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
        status VARCHAR(30) DEFAULT 'open' CHECK (status IN ('open', 'ai_resolved', 'escalated', 'closed', 'waiting_response')),
        ai_resolution TEXT,
        ai_confidence FLOAT,
        resolution_method VARCHAR(20) CHECK (resolution_method IN ('self_serve', 'ai', 'async', 'sync')),
        resolution_notes TEXT,
        decision_queue_id INTEGER REFERENCES decision_queue(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status, priority);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets (user_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        category VARCHAR(50) DEFAULT 'general',
        keywords TEXT[] DEFAULT '{}',
        view_count INTEGER DEFAULT 0,
        helpful_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed knowledge base
    await client.query(`
      INSERT INTO knowledge_base (title, content, category, keywords) VALUES
        ('How to import prospects via CSV', 'Go to Integrations > Upload CSV. Your CSV should have columns: email (required), first_name, last_name, company, title. Maximum 500 prospects per import. Duplicates are automatically skipped.', 'getting_started', ARRAY['csv', 'import', 'prospects', 'upload']),
        ('How the approval queue works', 'After AI generates emails, they appear in your Approval Queue. You can approve, edit then approve, or reject each email. Approved emails are automatically queued for sending. Bulk approve is available for batches.', 'email', ARRAY['approval', 'queue', 'approve', 'reject', 'edit']),
        ('Understanding email sequences', 'Koldly automatically generates Day 3 and Day 7 follow-ups for sent emails that haven''t received replies. Follow-ups use different angles to re-engage prospects. You can review and edit follow-ups before they send.', 'email', ARRAY['sequence', 'follow-up', 'day 3', 'day 7']),
        ('Setting up your sender identity', 'Go to Settings to configure your sender name and email. For best deliverability, use a professional email domain (not gmail/yahoo). Set up SPF and DKIM records for your domain.', 'deliverability', ARRAY['sender', 'identity', 'email', 'setup', 'spf', 'dkim']),
        ('Billing and plan limits', 'Free: 25 prospects, 1 campaign. Starter ($29/mo): 100 prospects, 1 campaign. Growth ($79/mo): 500 prospects, 5 campaigns. Scale ($199/mo): 2000 prospects, unlimited campaigns. Manage billing at /billing.', 'billing', ARRAY['plan', 'pricing', 'upgrade', 'limits', 'billing']),
        ('How AI generates emails', 'Koldly uses Claude AI to research prospects and write personalized emails. It analyzes the prospect''s company, role, and industry to craft relevant messaging. Each email is unique — not templated.', 'email', ARRAY['ai', 'generation', 'personalization', 'claude']),
        ('Reply handling and categorization', 'When prospects reply, Koldly''s AI categorizes them as: interested, objection, out-of-office, not interested, question, or spam. For interested and objection replies, AI drafts a response for your approval.', 'email', ARRAY['reply', 'categorization', 'interested', 'objection', 'response']),
        ('Email deliverability best practices', 'Start with small batches (10-15/day) and gradually increase. Use a dedicated sending domain. Set up SPF, DKIM, and DMARC records. Avoid spam trigger words. Keep emails concise and personalized.', 'deliverability', ARRAY['deliverability', 'spam', 'warmup', 'domain']),
        ('Connecting integrations', 'Koldly supports Slack notifications for replies and bounces. Go to Integrations to add your Slack webhook URL. CSV import is the primary method for adding prospects.', 'integrations', ARRAY['slack', 'integration', 'webhook', 'connect']),
        ('Campaign management', 'Create campaigns from the Campaigns page. Each campaign has its own ICP, prospects, and email pipeline. Archive old campaigns to keep your workspace clean. Export data anytime via CSV.', 'getting_started', ARRAY['campaign', 'create', 'archive', 'manage']),
        ('Understanding prospect fit scores', 'Fit scores (0-100) indicate how well a prospect matches your ICP. Scores are calculated during AI research based on company size, industry relevance, and role match. Higher scores get prioritized.', 'prospects', ARRAY['fit score', 'prospect', 'icp', 'scoring']),
        ('ICP templates', 'Save frequently used ICPs as templates. When creating a campaign, select a template to auto-populate the ICP description. Templates help maintain consistency across campaigns.', 'getting_started', ARRAY['icp', 'template', 'ideal customer profile']),
        ('Pipeline view explained', 'The pipeline shows prospects moving through stages: Discovered → Researched → Email Drafted → Approved → Sent → Replied → Meeting Booked. Track your campaign''s progress at a glance.', 'getting_started', ARRAY['pipeline', 'stages', 'funnel', 'tracking']),
        ('Troubleshooting email sending issues', 'If emails aren''t sending: 1) Check that your sender email is configured in Settings. 2) Verify your campaign is active (not paused). 3) Ensure you have approved emails in the queue. 4) Check your plan limits.', 'troubleshooting', ARRAY['sending', 'not working', 'stuck', 'troubleshoot', 'error']),
        ('Data privacy and security', 'Your data is encrypted at rest and in transit. Prospect data is isolated per campaign. We do not share your data with other users. You can delete campaigns and all associated data at any time.', 'security', ARRAY['privacy', 'security', 'data', 'encryption', 'delete'])
      ON CONFLICT DO NOTHING
    `);

    // ============================================
    // A/B TESTING
    // ============================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS ab_experiments (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        target VARCHAR(50) NOT NULL CHECK (target IN ('landing_copy', 'onboarding_flow', 'email_template', 'pricing', 'lifecycle_email', 'subject_line')),
        variants JSONB NOT NULL DEFAULT '[]',
        status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'concluded', 'cancelled')),
        winning_variant VARCHAR(100),
        sample_size_target INTEGER DEFAULT 100,
        start_date TIMESTAMPTZ,
        end_date TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ab_assignments (
        id SERIAL PRIMARY KEY,
        experiment_id INTEGER NOT NULL REFERENCES ab_experiments(id),
        user_id INTEGER,
        session_id VARCHAR(100),
        variant VARCHAR(100) NOT NULL,
        converted BOOLEAN DEFAULT false,
        conversion_event VARCHAR(100),
        converted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(experiment_id, user_id),
        UNIQUE(experiment_id, session_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ab_assignments_experiment ON ab_assignments (experiment_id, variant);
    `);

    // ============================================
    // PRODUCT SIGNALS
    // ============================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS product_signals (
        id SERIAL PRIMARY KEY,
        signal_type VARCHAR(50) NOT NULL CHECK (signal_type IN ('feature_request', 'bug_report', 'churn_indicator', 'expansion_signal', 'testimonial', 'voc_insight', 'positioning')),
        source VARCHAR(50) DEFAULT 'system',
        user_id INTEGER REFERENCES users(id),
        content TEXT,
        ai_analysis JSONB,
        priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
        status VARCHAR(20) DEFAULT 'new' CHECK (status IN ('new', 'processed', 'actioned', 'dismissed')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_product_signals_type_status ON product_signals (signal_type, status);
    `);

    // ============================================
    // OPERATOR DIGEST
    // ============================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS operator_digest (
        id SERIAL PRIMARY KEY,
        digest_type VARCHAR(20) NOT NULL CHECK (digest_type IN ('weekly', 'monthly', 'quarterly')),
        content JSONB NOT NULL,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ============================================
    // LIFECYCLE PROMPTS
    // ============================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS lifecycle_prompts (
        id SERIAL PRIMARY KEY,
        prompt_number INTEGER NOT NULL UNIQUE CHECK (prompt_number >= 3 AND prompt_number <= 9),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        activation_condition VARCHAR(100) NOT NULL,
        prompt_template TEXT NOT NULL,
        last_executed_at TIMESTAMPTZ,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed lifecycle prompts
    await client.query(`
      INSERT INTO lifecycle_prompts (prompt_number, name, description, activation_condition, prompt_template) VALUES
        (3, 'Weekly Optimization', 'Analyzes campaign performance and suggests subject line/body improvements', 'cron:0 9 * * 0', 'You are Koldly''s campaign optimization engine. Analyze the following campaign data from the past week and provide actionable recommendations.\n\nData:\n{{weekly_campaign_data}}\n\nProvide JSON with: { "top_performing_subjects": [], "underperforming_campaigns": [], "subject_line_suggestions": [], "body_improvements": [], "sending_time_recommendations": [] }'),
        (4, 'Churn Intervention', 'Generates personalized win-back emails for critical churn risk users', 'trigger:churn_risk_critical', 'You are a customer success expert for Koldly. A user is at critical risk of churning.\n\nUser Context:\n{{user_context}}\n\nDraft a personalized, empathetic email that:\n1. Acknowledges their specific situation\n2. Offers concrete help based on where they got stuck\n3. Includes a clear, low-friction next step\n4. Sounds human, not automated\n\nReturn JSON: { "subject": "string", "body": "string", "internal_notes": "string" }'),
        (5, 'Expansion Detection', 'Identifies users approaching plan limits who are ready for upgrade', 'cron:0 9 * * 0', 'You are Koldly''s growth engine. Analyze these users approaching plan limits and determine the best upgrade approach.\n\nUser Data:\n{{expansion_candidates}}\n\nFor each user, return JSON: { "users": [{ "user_id": number, "current_plan": "string", "recommended_plan": "string", "usage_percentage": number, "upgrade_angle": "string", "email_subject": "string", "email_body": "string" }] }'),
        (6, 'Support Resolution', 'First-pass AI support using knowledge base context', 'trigger:new_support_ticket', 'You are Koldly''s support assistant. A user has submitted a support ticket. Using the knowledge base articles and the user''s account context, provide a helpful resolution.\n\nTicket:\n{{ticket}}\n\nKnowledge Base Context:\n{{kb_context}}\n\nUser Account Context:\n{{user_context}}\n\nReturn JSON: { "resolution": "string (the response to send to the user)", "confidence": number (0-1), "matched_kb_articles": [number], "needs_escalation": boolean, "escalation_reason": "string or null" }'),
        (7, 'Product Signal Digest', 'Weekly digest of user behavior patterns and feature requests', 'cron:0 9 * * 0', 'You are Koldly''s product intelligence analyst. Analyze the following signals from the past week and generate actionable insights.\n\nSignals:\n{{weekly_signals}}\n\nUsage Metrics:\n{{usage_metrics}}\n\nReturn JSON: { "key_themes": [], "feature_requests_ranked": [], "churn_risk_patterns": [], "expansion_opportunities": [], "recommended_actions": [{ "action": "string", "priority": "string", "rationale": "string" }] }'),
        (8, 'Marketing Evolution', 'Monthly messaging performance and positioning review', 'cron:0 9 1 * *', 'You are Koldly''s marketing strategist. Review the following data and recommend messaging and positioning updates.\n\nTestimonials & VOC:\n{{voc_data}}\n\nConversion Metrics:\n{{conversion_metrics}}\n\nCurrent Positioning:\n{{current_positioning}}\n\nReturn JSON: { "positioning_score": number (1-10), "messaging_recommendations": [], "testimonial_highlights": [], "landing_page_suggestions": [], "email_template_suggestions": [] }'),
        (9, 'Strategic Review', 'Quarterly business health and pricing analysis', 'cron:0 9 1 1,4,7,10 *', 'You are Koldly''s strategic advisor. Conduct a quarterly review of the business.\n\nMetrics:\n{{quarterly_metrics}}\n\nReturn JSON: { "health_score": number (1-10), "revenue_analysis": { "mrr": number, "growth_rate": number, "churn_rate": number }, "pricing_recommendations": [], "product_priorities": [], "risk_factors": [], "opportunities": [], "90_day_plan": [] }')
      ON CONFLICT (prompt_number) DO NOTHING
    `);

    console.log('[Migration] Autonomous operations tables created successfully');
  }
};
