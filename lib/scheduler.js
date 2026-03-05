const cron = require('node-cron');

// Helper for rate limiting between items
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate follow-up email using AIService (Haiku)
async function generateFollowUpEmail(aiService, prospect, originalEmail, dayNumber, description) {
  const angleMap = {
    3: 'a different value proposition angle, referencing the original email but adding new perspective on ROI',
    7: 'a final breakup-style email with urgency and clear CTA, acknowledging silence but expressing genuine interest'
  };

  const angle = angleMap[dayNumber] || 'a follow-up email';

  const result = await aiService.callJSON('follow_up_generation', {
    system: `You are an expert cold email follow-up writer. Write a Day ${dayNumber} follow-up email that:
1. References the original email sent ${dayNumber} days ago
2. Uses ${angle}
3. Keeps it concise (under 100 words)
4. Includes a clear CTA (soft for Day 3, direct for Day 7)
5. Sounds natural and personal, not templated
6. Maintains the same tone as the original

Return as JSON: {"subject": "...", "body": "...", "notes": "..."}`,
    messages: [
      {
        role: 'user',
        content: `Company: ${prospect.company_name}
Industry: ${prospect.industry}
Original Email Subject: ${originalEmail.subject_line}
Original Email Body: ${originalEmail.email_body}

Our Solution: ${description}`
      }
    ]
  });

  const emailData = result.content;
  return {
    subject: emailData.subject || '',
    body: emailData.body || '',
    notes: emailData.notes || ''
  };
}

// Main scheduler job - generate follow-ups for emails sent 3 and 7 days ago
async function runSequenceJob(pool, aiService) {
  console.log('[Scheduler] Starting email sequence follow-up job');
  const startTime = Date.now();

  const stats = { total: 0, day3: 0, day7: 0, failed: 0 };

  try {
    // Get all sent emails that need Day 3 follow-ups
    // (sent exactly 3+ days ago AND no Day 3 sequence step exists)
    const day3Result = await pool.query(`
      SELECT
        ge.id as email_id,
        ge.prospect_id,
        ge.campaign_id,
        ge.recipient_name,
        ge.subject_line,
        ge.email_body,
        ge.sent_at,
        p.company_name,
        p.industry,
        c.description
      FROM generated_emails ge
      JOIN prospects p ON ge.prospect_id = p.id
      JOIN campaigns c ON ge.campaign_id = c.id
      WHERE ge.status = 'sent'
        AND ge.sent_at IS NOT NULL
        AND ge.sent_at <= NOW() - INTERVAL '3 days'
        AND NOT EXISTS (
          SELECT 1 FROM email_sequences es
          WHERE es.original_email_id = ge.id
        )
      LIMIT 50
    `);

    console.log(`[Scheduler] Found ${day3Result.rows.length} emails needing Day 3 follow-ups`);
    stats.total += day3Result.rows.length;

    // Generate Day 3 sequences
    for (let i = 0; i < day3Result.rows.length; i++) {
      const email = day3Result.rows[i];
      try {
        // Create sequence record
        const seqResult = await pool.query(
          `INSERT INTO email_sequences (prospect_id, campaign_id, original_email_id, sequence_type)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [email.prospect_id, email.campaign_id, email.email_id, 'standard']
        );

        const sequenceId = seqResult.rows[0].id;

        // Generate Day 3 follow-up
        const day3Email = await generateFollowUpEmail(
          aiService,
          { company_name: email.company_name, industry: email.industry },
          { subject_line: email.subject_line, email_body: email.email_body },
          3,
          email.description
        );

        // Create Day 3 step
        await pool.query(
          `INSERT INTO email_sequence_steps (sequence_id, step_number, days_after_initial, subject_line, email_body, personalization_notes, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [sequenceId, 1, 3, day3Email.subject, day3Email.body, day3Email.notes, 'pending']
        );

        // Generate Day 7 follow-up
        const day7Email = await generateFollowUpEmail(
          aiService,
          { company_name: email.company_name, industry: email.industry },
          { subject_line: email.subject_line, email_body: email.email_body },
          7,
          email.description
        );

        // Create Day 7 step
        await pool.query(
          `INSERT INTO email_sequence_steps (sequence_id, step_number, days_after_initial, subject_line, email_body, personalization_notes, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [sequenceId, 2, 7, day7Email.subject, day7Email.body, day7Email.notes, 'pending']
        );

        stats.day3++;
        console.log(`[Scheduler] ✓ Created sequence for email #${email.email_id}`);
      } catch (err) {
        stats.failed++;
        console.error(`[Scheduler] ✗ Failed to create sequence for email #${email.email_id}:`, err.message);
      }

      // Rate limiting between AI calls
      if (i < day3Result.rows.length - 1) {
        await delay(500);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Scheduler] Complete in ${duration}s - Day 3 sequences: ${stats.day3}, Failed: ${stats.failed}`);
  } catch (err) {
    console.error('[Scheduler] Fatal error:', err);
  }
}

// Process campaign sending queue
async function processSendingQueue(pool) {
  console.log('[Scheduler] Processing campaign sending queue');

  try {
    const CampaignSendingService = require('./campaign-sending-service');
    const sendingService = new CampaignSendingService(pool);
    await sendingService.processSendingQueue();
  } catch (err) {
    console.error('[Scheduler] Sending queue processing error:', err);
  }
}

// Autonomous pipeline: process new campaigns (discover → research → generate emails)
async function runPipelineJob(pool) {
  console.log('[Pipeline] Starting autonomous pipeline processing');
  const ProspectDiscoveryService = require('./prospect-discovery-service');
  const EmailGenerationService = require('./email-generation-service');
  const ReplyResponseService = require('./reply-response-service');

  const discoveryService = new ProspectDiscoveryService(pool);
  const emailGenService = new EmailGenerationService(pool);
  const replyResponseService = new ReplyResponseService(pool);

  try {
    // 1. Find campaigns needing discovery
    const pendingCampaigns = await pool.query(`
      SELECT c.id, c.user_id FROM campaigns c
      WHERE c.discovery_status = 'pending'
        AND c.status = 'active'
        AND (c.is_archived = false OR c.is_archived IS NULL)
      LIMIT 5
    `);

    for (const campaign of pendingCampaigns.rows) {
      try {
        console.log(`[Pipeline] Discovering prospects for campaign #${campaign.id}`);
        await discoveryService.discoverProspects(campaign.id, campaign.user_id, 25);
      } catch (err) {
        console.error(`[Pipeline] Discovery failed for campaign #${campaign.id}:`, err.message);
      }
    }

    // 2. Research discovered prospects
    const campaignsWithDiscovered = await pool.query(`
      SELECT DISTINCT c.id, c.user_id FROM campaigns c
      JOIN prospects p ON p.campaign_id = c.id
      WHERE p.status = 'discovered'
        AND c.discovery_status = 'completed'
        AND c.status = 'active'
      LIMIT 5
    `);

    for (const campaign of campaignsWithDiscovered.rows) {
      try {
        console.log(`[Pipeline] Researching prospects for campaign #${campaign.id}`);
        await discoveryService.researchProspects(campaign.id, campaign.user_id, null, 5);
      } catch (err) {
        console.error(`[Pipeline] Research failed for campaign #${campaign.id}:`, err.message);
      }
    }

    // 3. Generate emails for researched prospects
    const campaignsWithResearched = await pool.query(`
      SELECT DISTINCT c.id, c.user_id FROM campaigns c
      JOIN prospects p ON p.campaign_id = c.id
      WHERE p.status = 'researched'
        AND c.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM generated_emails ge
          WHERE ge.prospect_id = p.id AND ge.status != 'rejected'
        )
      LIMIT 5
    `);

    const PushService = require('./push-service');
    const pushService = new PushService(pool);

    for (const campaign of campaignsWithResearched.rows) {
      try {
        console.log(`[Pipeline] Generating emails for campaign #${campaign.id}`);
        const genResult = await emailGenService.generateForCampaign(campaign.id, campaign.user_id, 5);

        // Push notification: new items ready for approval
        if (genResult.generated > 0) {
          const badge = await pushService.getApprovalBadgeCount(campaign.user_id);
          await pushService.notifyUser(campaign.user_id, 'new_approval_items', {
            count: genResult.generated,
            badge
          }, { campaign_id: campaign.id }).catch(err =>
            console.warn('[Pipeline] Push notification failed:', err.message)
          );
        }
      } catch (err) {
        console.error(`[Pipeline] Email gen failed for campaign #${campaign.id}:`, err.message);
      }
    }

    // 4. Auto-queue approved emails into sending queue
    const CampaignSendingService = require('./campaign-sending-service');
    const sendingService = new CampaignSendingService(pool);

    const campaignsWithApproved = await pool.query(`
      SELECT DISTINCT c.id as campaign_id, c.user_id,
        u.sender_email, u.sender_name
      FROM campaigns c
      JOIN prospects p ON p.campaign_id = c.id
      JOIN generated_emails ge ON ge.prospect_id = p.id AND ge.campaign_id = c.id
      JOIN users u ON c.user_id = u.id
      WHERE ge.status = 'approved'
        AND c.status = 'active'
        AND u.sender_email IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM campaign_sending_queue csq
          WHERE csq.generated_email_id = ge.id
        )
      LIMIT 10
    `);

    for (const row of campaignsWithApproved.rows) {
      try {
        // Ensure sending context exists
        await pool.query(`
          INSERT INTO campaign_sending_context (campaign_id, status, prospect_count, sender_email, sender_name, reply_to_email)
          VALUES ($1, 'active', 0, $2, $3, $2)
          ON CONFLICT (campaign_id) DO NOTHING
        `, [row.campaign_id, row.sender_email, row.sender_name || row.sender_email.split('@')[0]]);

        const queued = await sendingService.queueInitialEmails(row.campaign_id);
        if (queued > 0) {
          console.log(`[Pipeline] Auto-queued ${queued} approved emails for campaign #${row.campaign_id}`);
        }
      } catch (err) {
        console.error(`[Pipeline] Auto-queue failed for campaign #${row.campaign_id}:`, err.message);
      }
    }

    // 5. Process new replies (categorize + draft responses)
    const usersWithReplies = await pool.query(`
      SELECT DISTINCT c.user_id FROM prospect_reply_inbox pri
      JOIN campaigns c ON pri.campaign_id = c.id
      WHERE pri.category IS NULL
        AND NOT EXISTS (SELECT 1 FROM reply_drafts rd WHERE rd.reply_id = pri.id)
      LIMIT 10
    `);

    for (const row of usersWithReplies.rows) {
      try {
        console.log(`[Pipeline] Processing replies for user #${row.user_id}`);
        const replyResult = await replyResponseService.processNewReplies(row.user_id);

        // Push notification for each interesting reply
        if (replyResult && replyResult.processed > 0) {
          // Find the most recent company name for the notification
          const recentReply = await pool.query(
            `SELECT p.company_name FROM prospect_reply_inbox pri
             JOIN campaigns c ON pri.campaign_id = c.id
             JOIN prospects p ON pri.prospect_id = p.id
             WHERE c.user_id = $1
             ORDER BY pri.received_at DESC LIMIT 1`,
            [row.user_id]
          );
          const companyName = recentReply.rows[0]?.company_name || 'A prospect';
          await pushService.notifyUser(row.user_id, 'reply_received', { company: companyName })
            .catch(err => console.warn('[Pipeline] Push notification (reply) failed:', err.message));
        }
      } catch (err) {
        console.error(`[Pipeline] Reply processing failed for user #${row.user_id}:`, err.message);
      }
    }

    console.log('[Pipeline] Autonomous pipeline processing complete');
  } catch (err) {
    console.error('[Pipeline] Fatal error:', err);
  }
}

// ============================================
// BETA LIFECYCLE EMAIL SCHEDULER
// ============================================

/**
 * Beta lifecycle emails sent via Postmark transactional.
 * Runs hourly. Checks each beta user's signup date and activation status.
 * Sends Day 1, Day 3 (nudge), Day 7, Day 14, Day 21 emails.
 * Tracks sent emails in beta_emails_sent to avoid duplicates.
 */
async function runBetaLifecycleEmails(pool) {
  console.log('[Beta] Processing lifecycle emails');
  const EmailService = require('./email-service');
  const emailService = new EmailService(pool);
  const appUrl = process.env.APP_URL || 'https://koldly.com';

  // Email templates keyed by email_key
  const templates = {
    day1_checkin: {
      day: 1,
      requiresActivation: false,
      subject: "How's your first campaign going?",
      html: (name) => `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #FF6B35;">Quick check-in</h2>
        <p>Hi${name ? ' ' + name : ''},</p>
        <p>Just checking in on your first day. If you've already imported prospects and reviewed your AI-drafted emails — amazing.</p>
        <p>If you got stuck anywhere, reply to this email and I'll help you through it personally.</p>
        <p>If you haven't started yet, here's the fastest path:</p>
        <ol>
          <li>Go to <a href="${appUrl}/integrations" style="color: #FF6B35;">Integrations</a></li>
          <li>Upload your prospect CSV</li>
          <li>The AI will start drafting emails within minutes</li>
        </ol>
        <p style="color: #666; font-size: 14px;">— The Koldly team<br><a href="mailto:support@koldly.com" style="color: #FF6B35;">support@koldly.com</a></p>
      </div>`
    },
    day3_nudge: {
      day: 3,
      requiresActivation: false,
      onlyIfNotActivated: true,
      subject: 'Your AI emails are waiting',
      html: (name) => `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #FF6B35;">Your AI emails are waiting</h2>
        <p>Hi${name ? ' ' + name : ''},</p>
        <p>I noticed you haven't reviewed any emails yet. The best way to see if Koldly works for you is to import a real prospect list and see what the AI drafts.</p>
        <p>Takes about 5 minutes:</p>
        <a href="${appUrl}/dashboard" style="display: inline-block; padding: 12px 24px; background: #FF6B35; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 16px 0;">Go to Dashboard →</a>
        <p>If something's confusing or broken, I want to know — just reply to this email.</p>
        <p style="color: #666; font-size: 14px;">— The Koldly team</p>
      </div>`
    },
    day7_midpoint: {
      day: 7,
      requiresActivation: false,
      subject: "One week in — how's it going?",
      html: (name) => `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #FF6B35;">One week in</h2>
        <p>Hi${name ? ' ' + name : ''},</p>
        <p>You're a week into the Koldly beta. I'd love to hear from you:</p>
        <ol>
          <li>What's working well?</li>
          <li>What's frustrating or confusing?</li>
          <li>Anything missing that would make this obviously worth paying for?</li>
        </ol>
        <p>Just reply — even a one-line answer helps me build something better for you.</p>
        <p style="color: #666; font-size: 14px;">— The Koldly team</p>
      </div>`
    },
    day14_feedback: {
      day: 14,
      requiresActivation: false,
      subject: 'Quick 15-min call? I have questions.',
      html: (name) => `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #FF6B35;">Halfway point</h2>
        <p>Hi${name ? ' ' + name : ''},</p>
        <p>We're at the halfway mark of the beta. I'd like to do a quick 15-minute call to hear what you think — what's working, what isn't, and what would make you recommend Koldly to another founder.</p>
        ${process.env.BETA_SCHEDULING_URL ? `<a href="${process.env.BETA_SCHEDULING_URL}" style="display: inline-block; padding: 12px 24px; background: #FF6B35; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 16px 0;">Book a 15-min call →</a>` : ''}
        <p>If you prefer async, just reply with your thoughts. A few questions:</p>
        <ul>
          <li>How many replies have you gotten so far?</li>
          <li>How does that compare to your previous outreach approach?</li>
          <li>Approximately how much time per week has Koldly saved you?</li>
        </ul>
        <p>Your feedback directly shapes what gets built next.</p>
        <p style="color: #666; font-size: 14px;">— The Koldly team</p>
      </div>`
    },
    day21_close: {
      day: 21,
      requiresActivation: false,
      subject: "Beta's ending — here's what's next",
      html: (name) => `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #FF6B35;">Thank you</h2>
        <p>Hi${name ? ' ' + name : ''},</p>
        <p>Thank you for being part of the Koldly beta. Your feedback has been invaluable.</p>
        <p><strong>Here's what happens next:</strong></p>
        <ul>
          <li>Your Growth plan access continues for 2 more months (3 months total)</li>
          <li>The features you asked for are being prioritized</li>
          <li>As a founding member, you'll always get early access</li>
        </ul>
        <p><strong>One last ask:</strong> if Koldly has helped your outreach, would you be willing to share a quick quote I can use on the site? Just reply with 2-3 sentences about your experience.</p>
        <p style="color: #666; font-size: 14px;">— The Koldly team</p>
      </div>`
    }
  };

  try {
    // Get all beta users
    const betaUsers = await pool.query(`
      SELECT id, email, name, created_at, activated_at
      FROM users
      WHERE is_beta_user = true
    `);

    for (const user of betaUsers.rows) {
      const daysSinceSignup = Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24));
      const isActivated = !!user.activated_at;

      for (const [emailKey, template] of Object.entries(templates)) {
        // Check if it's time to send this email
        if (daysSinceSignup < template.day) continue;

        // Skip day3 nudge if user is already activated
        if (template.onlyIfNotActivated && isActivated) continue;

        // Check if already sent
        try {
          const alreadySent = await pool.query(
            'SELECT id FROM beta_emails_sent WHERE user_id = $1 AND email_key = $2',
            [user.id, emailKey]
          );
          if (alreadySent.rows.length > 0) continue;

          // Send the email
          await emailService.sendTransactionalEmail(
            user.email,
            template.subject,
            template.html(user.name)
          );

          // Mark as sent
          await pool.query(
            'INSERT INTO beta_emails_sent (user_id, email_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [user.id, emailKey]
          );

          console.log(`[Beta] Sent ${emailKey} to ${user.email}`);
        } catch (sendErr) {
          console.error(`[Beta] Failed to send ${emailKey} to ${user.email}:`, sendErr.message);
        }
      }
    }

    console.log('[Beta] Lifecycle email processing complete');
  } catch (err) {
    console.error('[Beta] Lifecycle email error:', err);
  }
}

// ============================================
// AI GTM ADVISOR JOB
// Generates per-user proactive insights from campaign performance data
// ============================================

async function runAdvisorJob(pool, aiService) {
  console.log('[Advisor] Starting AI GTM advisor insight generation');

  try {
    // Get users who have active campaigns with performance data
    const users = await pool.query(`
      SELECT DISTINCT c.user_id
      FROM campaigns c
      JOIN prospects p ON p.campaign_id = c.id
      WHERE c.status = 'active'
        AND c.created_at <= NOW() - INTERVAL '3 days'
      LIMIT 50
    `);

    let generated = 0;

    for (const row of users.rows) {
      const userId = row.user_id;
      try {
        // Gather campaign performance data for this user
        const perfData = await pool.query(`
          SELECT
            c.id as campaign_id,
            c.name as campaign_name,
            COUNT(ge.id) FILTER (WHERE ge.status = 'sent') as emails_sent,
            COUNT(pri.id) as total_replies,
            COUNT(pri.id) FILTER (WHERE pri.category = 'interested') as interested_replies,
            COUNT(pri.id) FILTER (WHERE pri.category = 'not_interested') as not_interested,
            COUNT(ge.id) FILTER (WHERE ge.status = 'pending_approval') as pending_approval,
            AVG(EXTRACT(EPOCH FROM (ge.sent_at - ge.created_at))/3600) as avg_hours_to_approve,
            MAX(ge.sent_at) as last_send_at
          FROM campaigns c
          LEFT JOIN generated_emails ge ON ge.campaign_id = c.id
          LEFT JOIN prospect_reply_inbox pri ON pri.campaign_id = c.id
          WHERE c.user_id = $1 AND c.status = 'active'
          GROUP BY c.id, c.name
          HAVING COUNT(ge.id) > 0
          ORDER BY emails_sent DESC
          LIMIT 5
        `, [userId]);

        if (perfData.rows.length === 0) continue;

        // Check for existing unread insights (avoid flooding)
        const existingCount = await pool.query(
          `SELECT COUNT(*) as count FROM advisor_insights
           WHERE user_id = $1 AND read_at IS NULL AND dismissed_at IS NULL
             AND created_at > NOW() - INTERVAL '7 days'`,
          [userId]
        );
        if (parseInt(existingCount.rows[0].count) >= 5) continue;

        // Generate insights via Haiku (cheap at scale)
        const campaignSummary = perfData.rows.map(c => ({
          name: c.campaign_name,
          sent: parseInt(c.emails_sent) || 0,
          replies: parseInt(c.total_replies) || 0,
          interested: parseInt(c.interested_replies) || 0,
          pending: parseInt(c.pending_approval) || 0,
          avgHoursToApprove: parseFloat(c.avg_hours_to_approve) || 0,
          daysSinceLastSend: c.last_send_at
            ? Math.floor((Date.now() - new Date(c.last_send_at).getTime()) / 86400000)
            : 99
        }));

        const result = await aiService.callJSON('advisor_insight', {
          system: `You are an AI GTM advisor for a sales outreach platform. Analyze campaign performance data and generate 1-3 actionable, specific insights. Be direct and data-driven.

Return JSON array of insight objects:
[{
  "insight_type": "follow_up_dropoff|unread_reply|icp_angle|sequence_gap|deliverability_warning|approval_bottleneck",
  "title": "Short title (max 60 chars)",
  "body": "Specific insight with data points (max 200 chars)",
  "priority": "high|medium|low",
  "action_label": "Optional CTA label",
  "campaign_id": number or null
}]

Only return insights that are genuinely actionable. Return [] if no insights are needed.`,
          messages: [{
            role: 'user',
            content: JSON.stringify(campaignSummary)
          }]
        });

        const insights = Array.isArray(result.content) ? result.content : [];

        for (const insight of insights.slice(0, 3)) {
          if (!insight.title || !insight.body) continue;

          await pool.query(
            `INSERT INTO advisor_insights
             (user_id, campaign_id, insight_type, title, body, action_label, priority, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '14 days')`,
            [
              userId,
              insight.campaign_id || null,
              insight.insight_type || 'icp_angle',
              insight.title.slice(0, 255),
              insight.body.slice(0, 1000),
              insight.action_label || null,
              ['high', 'medium', 'low'].includes(insight.priority) ? insight.priority : 'medium'
            ]
          );
          generated++;

          // Push notification for high-priority insights
          if (insight.priority === 'high') {
            const PushService = require('./push-service');
            const pushService = new PushService(pool);
            await pushService.notifyUser(userId, 'advisor_insight', { msg: insight.body.slice(0, 100) })
              .catch(err => console.warn('[Advisor] Push failed:', err.message));
          }
        }

        await delay(300); // Rate limit between users
      } catch (err) {
        console.error(`[Advisor] Failed for user ${userId}:`, err.message);
      }
    }

    console.log(`[Advisor] Generated ${generated} insights for ${users.rows.length} users`);
  } catch (err) {
    console.error('[Advisor] Fatal error:', err.message);
  }
}

// ============================================
// INTELLIGENCE NETWORK AGGREGATION
// Aggregates opted-in anonymized signals into benchmark_data weekly
// ============================================

async function runIntelligenceAggregation(pool) {
  console.log('[Intelligence] Starting weekly signal aggregation');

  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday of this week
    const weekStartStr = weekStart.toISOString().split('T')[0];

    // Step 1: Collect new anonymized signals from opted-in users
    // Maps real campaign performance → intelligence_signals (no PII stored)
    await pool.query(`
      INSERT INTO intelligence_signals
        (icp_industry, icp_company_size_bucket, icp_job_title_category,
         subject_word_count, body_word_count, sequence_step,
         has_personalization, opened, replied, reply_category,
         email_angle, sent_week, data_source)
      SELECT
        COALESCE(p.industry, 'unknown') as icp_industry,
        COALESCE(p.company_size, 'unknown') as icp_company_size_bucket,
        COALESCE(p.contact_title, 'unknown') as icp_job_title_category,
        array_length(regexp_split_to_array(trim(ge.subject_line), '\\s+'), 1) as subject_word_count,
        array_length(regexp_split_to_array(trim(ge.email_body), '\\s+'), 1) as body_word_count,
        COALESCE(ess.step_number, 1) as sequence_step,
        ge.personalization_notes IS NOT NULL as has_personalization,
        eds.opened_at IS NOT NULL as opened,
        pri.id IS NOT NULL as replied,
        pri.category as reply_category,
        'standard' as email_angle,
        DATE_TRUNC('week', ge.sent_at)::date as sent_week,
        COALESCE(p.data_source, 'unknown') as data_source
      FROM generated_emails ge
      JOIN campaigns c ON ge.campaign_id = c.id
      JOIN intelligence_opt_ins ioi ON ioi.user_id = c.user_id AND ioi.opted_in = TRUE
      JOIN prospects p ON ge.prospect_id = p.id
      LEFT JOIN email_delivery_status eds ON eds.generated_email_id = ge.id
      LEFT JOIN email_sequence_steps ess ON ess.id = ge.sequence_step_id
      LEFT JOIN prospect_reply_inbox pri ON pri.prospect_id = ge.prospect_id
        AND pri.campaign_id = ge.campaign_id
      WHERE ge.status = 'sent'
        AND ge.sent_at >= $1
        AND ge.sent_at IS NOT NULL
    `, [weekAgo]);

    // Step 2: Aggregate signals into benchmark_data for this week
    await pool.query(`
      INSERT INTO benchmark_data
        (icp_industry, icp_company_size_bucket, icp_job_title_category,
         email_angle, sequence_step, week_start,
         sample_size, open_count, reply_count, interested_count,
         open_rate, reply_rate, interested_rate, computed_at)
      SELECT
        icp_industry,
        icp_company_size_bucket,
        icp_job_title_category,
        COALESCE(email_angle, 'standard') as email_angle,
        sequence_step,
        $1::date as week_start,
        COUNT(*) as sample_size,
        SUM(CASE WHEN opened THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN replied THEN 1 ELSE 0 END) as reply_count,
        SUM(CASE WHEN reply_category = 'interested' THEN 1 ELSE 0 END) as interested_count,
        ROUND(SUM(CASE WHEN opened THEN 1 ELSE 0 END)::numeric / COUNT(*), 4) as open_rate,
        ROUND(SUM(CASE WHEN replied THEN 1 ELSE 0 END)::numeric / COUNT(*), 4) as reply_rate,
        ROUND(SUM(CASE WHEN reply_category = 'interested' THEN 1 ELSE 0 END)::numeric / COUNT(*), 4) as interested_rate,
        NOW() as computed_at
      FROM intelligence_signals
      WHERE sent_week = DATE_TRUNC('week', NOW() - INTERVAL '1 week')::date
      GROUP BY icp_industry, icp_company_size_bucket, icp_job_title_category, email_angle, sequence_step
      HAVING COUNT(*) >= 10
      ON CONFLICT (icp_industry, icp_company_size_bucket, icp_job_title_category, email_angle, sequence_step, week_start)
      DO UPDATE SET
        sample_size = EXCLUDED.sample_size,
        open_count = EXCLUDED.open_count,
        reply_count = EXCLUDED.reply_count,
        interested_count = EXCLUDED.interested_count,
        open_rate = EXCLUDED.open_rate,
        reply_rate = EXCLUDED.reply_rate,
        interested_rate = EXCLUDED.interested_rate,
        computed_at = NOW()
    `, [weekStartStr]);

    // Step 3: Expire stale recommendations
    await pool.query(`DELETE FROM icp_similarity_recommendations WHERE expires_at < NOW()`);

    console.log('[Intelligence] Weekly aggregation complete');
  } catch (err) {
    console.error('[Intelligence] Aggregation error:', err.message);
  }
}

// Initialize scheduler
function initializeScheduler(pool, aiService, schedule = '0 0 * * *') {
  console.log(`[Scheduler] Initializing with schedule: ${schedule}`);

  if (!cron.validate(schedule)) {
    console.error('[Scheduler] Invalid cron schedule:', schedule);
    return null;
  }

  // Lazy-load autonomous services (avoids circular requires at startup)
  const loadRetention = () => { const S = require('./retention-service'); return new S(pool); };
  const loadOnboarding = () => { const S = require('./onboarding-service'); return new S(pool); };
  const loadDecisionQueue = () => { const S = require('./decision-queue-service'); return new S(pool); };
  const loadSupport = () => { const S = require('./support-service'); return new S(pool); };
  const loadProductIntel = () => { const S = require('./product-intelligence-service'); return new S(pool); };
  const loadMarketing = () => { const S = require('./marketing-service'); return new S(pool); };
  const loadStripe = () => { const S = require('./stripe-service'); return new S(pool); };

  // ============================================
  // EXISTING JOBS
  // ============================================

  // Main sequence job (daily at midnight)
  const sequenceTask = cron.schedule(schedule, () => {
    runSequenceJob(pool, aiService);
  }, { scheduled: true, timezone: 'UTC' });

  // Campaign sending queue processor (every 5 minutes)
  const sendingTask = cron.schedule('*/5 * * * *', () => {
    processSendingQueue(pool);
  }, { scheduled: true, timezone: 'UTC' });

  // Autonomous pipeline processor (every 15 minutes)
  const pipelineTask = cron.schedule('*/15 * * * *', () => {
    runPipelineJob(pool);
  }, { scheduled: true, timezone: 'UTC' });

  // Cache cleanup — expire old AI cache entries (daily at 3am)
  const cacheCleanupTask = cron.schedule('0 3 * * *', async () => {
    try {
      const result = await pool.query('DELETE FROM ai_cache WHERE expires_at < NOW()');
      console.log(`[Scheduler] Cache cleanup: removed ${result.rowCount} expired entries`);
    } catch (err) {
      console.error('[Scheduler] Cache cleanup error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // Beta lifecycle emails (every hour)
  const betaLifecycleTask = cron.schedule('0 * * * *', () => {
    runBetaLifecycleEmails(pool);
  }, { scheduled: true, timezone: 'UTC' });

  // ============================================
  // AUTONOMOUS OPERATIONS JOBS
  // ============================================

  // Retention engine: engagement scoring + retention actions (daily at 8am UTC)
  const retentionTask = cron.schedule('0 8 * * *', async () => {
    try {
      const retention = loadRetention();
      await retention.runEngagementScoring();
      await retention.runRetentionActions();
    } catch (err) {
      console.error('[Scheduler] Retention engine error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // Dunning sequence processor (daily at 9am UTC)
  const dunningTask = cron.schedule('0 9 * * *', async () => {
    try {
      const stripe = loadStripe();
      const result = await stripe.processDunningSequence();
      console.log(`[Scheduler] Dunning: day3=${result.day3}, day7=${result.day7}, day14=${result.day14}`);
    } catch (err) {
      console.error('[Scheduler] Dunning processor error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // Stuck user detection (every 6 hours: midnight, 6am, noon, 6pm)
  const stuckDetectionTask = cron.schedule('0 */6 * * *', async () => {
    try {
      const onboarding = loadOnboarding();
      await onboarding.detectStuckUsers();
    } catch (err) {
      console.error('[Scheduler] Stuck detection error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // Decision queue maintenance: execute scheduled + expire stale (every hour)
  const decisionMaintenanceTask = cron.schedule('30 * * * *', async () => {
    try {
      const dq = loadDecisionQueue();
      await dq.executeScheduled();
      await dq.autoExpire();
    } catch (err) {
      console.error('[Scheduler] Decision queue maintenance error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // Support ticket retriage (every 4 hours)
  const supportTriageTask = cron.schedule('0 */4 * * *', async () => {
    try {
      const support = loadSupport();
      const result = await support.retriageOpenTickets();
      if (result.resolved > 0) {
        console.log(`[Scheduler] Support retriage: resolved ${result.resolved}/${result.checked}`);
      }
    } catch (err) {
      console.error('[Scheduler] Support retriage error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // Weekly product report + positioning check (Mondays at 7am UTC)
  const weeklyReportTask = cron.schedule('0 7 * * 1', async () => {
    try {
      const intel = loadProductIntel();
      await intel.generateWeeklyProductReport();
      const marketing = loadMarketing();
      await marketing.checkPositioningEvolution();
      console.log('[Scheduler] Weekly reports generated');
    } catch (err) {
      console.error('[Scheduler] Weekly report error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // Monthly marketing review + VOC report (1st of month at 7am UTC)
  const monthlyReportTask = cron.schedule('0 7 1 * *', async () => {
    try {
      const intel = loadProductIntel();
      await intel.generateMonthlyMarketingReview();
      const marketing = loadMarketing();
      await marketing.generateVOCReport();
      console.log('[Scheduler] Monthly reports generated');
    } catch (err) {
      console.error('[Scheduler] Monthly report error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // Quarterly strategic review (1st of Jan/Apr/Jul/Oct at 7am UTC)
  const quarterlyReportTask = cron.schedule('0 7 1 1,4,7,10 *', async () => {
    try {
      const intel = loadProductIntel();
      await intel.generateQuarterlyReview();
      console.log('[Scheduler] Quarterly review generated');
    } catch (err) {
      console.error('[Scheduler] Quarterly report error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // ============================================
  // TIER 2 + 3 JOBS
  // ============================================

  // AI GTM Advisor: generate per-user insights (daily at 7:30am UTC)
  const advisorTask = cron.schedule('30 7 * * *', async () => {
    try {
      await runAdvisorJob(pool, aiService);
    } catch (err) {
      console.error('[Scheduler] Advisor job error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // Intelligence network: aggregate signals into benchmarks (Sundays at 2am UTC)
  const intelligenceTask = cron.schedule('0 2 * * 0', async () => {
    try {
      await runIntelligenceAggregation(pool);
    } catch (err) {
      console.error('[Scheduler] Intelligence aggregation error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // Video task poller: check for completed video renders (every 5 minutes)
  const videoPollerTask = cron.schedule('*/5 * * * *', async () => {
    try {
      const VideoService = require('./video-service');
      const videoService = new VideoService(pool);
      await videoService.pollRenderingVideos();
    } catch (err) {
      console.error('[Scheduler] Video poller error:', err.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  // ============================================
  // STARTUP LOGGING
  // ============================================

  console.log('[Scheduler] Email sequence scheduler initialized (daily)');
  console.log('[Scheduler] Campaign sending queue processor initialized (every 5 min)');
  console.log('[Scheduler] Autonomous pipeline processor initialized (every 15 min)');
  console.log('[Scheduler] Cache cleanup initialized (daily at 3am UTC)');
  console.log('[Scheduler] Beta lifecycle emails initialized (hourly)');
  console.log('[Scheduler] Retention engine initialized (daily at 8am UTC)');
  console.log('[Scheduler] Dunning processor initialized (daily at 9am UTC)');
  console.log('[Scheduler] Stuck user detection initialized (every 6h)');
  console.log('[Scheduler] Decision queue maintenance initialized (hourly)');
  console.log('[Scheduler] Support retriage initialized (every 4h)');
  console.log('[Scheduler] Weekly/monthly/quarterly reports initialized');

  console.log('[Scheduler] AI GTM Advisor initialized (daily at 7:30am UTC)');
  console.log('[Scheduler] Intelligence aggregation initialized (Sundays at 2am UTC)');
  console.log('[Scheduler] Video task poller initialized (every 5 min)');

  return {
    task: sequenceTask,
    sendingTask,
    pipelineTask,
    betaLifecycleTask,
    retentionTask,
    dunningTask,
    stuckDetectionTask,
    decisionMaintenanceTask,
    supportTriageTask,
    weeklyReportTask,
    monthlyReportTask,
    quarterlyReportTask,
    advisorTask,
    intelligenceTask,
    videoPollerTask,
    runNow: () => runSequenceJob(pool, aiService),
    processSendingQueueNow: () => processSendingQueue(pool),
    runPipelineNow: () => runPipelineJob(pool),
    runBetaLifecycleNow: () => runBetaLifecycleEmails(pool),
    runAdvisorNow: () => runAdvisorJob(pool, aiService),
    runIntelligenceNow: () => runIntelligenceAggregation(pool)
  };
}

module.exports = {
  initializeScheduler,
  runSequenceJob,
  processSendingQueue,
  runPipelineJob,
  runBetaLifecycleEmails,
  runAdvisorJob,
  runIntelligenceAggregation
};
