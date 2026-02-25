const cron = require('node-cron');
const OpenAI = require('openai');

// Helper for rate limiting between items
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate follow-up email using OpenAI
async function generateFollowUpEmail(openai, prospect, originalEmail, dayNumber, description) {
  const angleMap = {
    3: 'a different value proposition angle, referencing the original email but adding new perspective on ROI',
    7: 'a final breakup-style email with urgency and clear CTA, acknowledging silence but expressing genuine interest'
  };

  const angle = angleMap[dayNumber] || 'a follow-up email';

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are an expert cold email follow-up writer. Write a Day ${dayNumber} follow-up email that:
1. References the original email sent ${dayNumber} days ago
2. Uses ${angle}
3. Keeps it concise (under 100 words)
4. Includes a clear CTA (soft for Day 3, direct for Day 7)
5. Sounds natural and personal, not templated
6. Maintains the same tone as the original

Return as JSON: {"subject": "...", "body": "...", "notes": "..."}`
      },
      {
        role: 'user',
        content: `Company: ${prospect.company_name}
Industry: ${prospect.industry}
Original Email Subject: ${originalEmail.subject_line}
Original Email Body: ${originalEmail.email_body}

Our Solution: ${description}`
      }
    ],
    temperature: 0.7,
    response_format: { type: 'json_object' }
  });

  let emailData = { subject: '', body: '', notes: '' };
  try {
    emailData = JSON.parse(completion.choices[0].message.content);
  } catch (e) {
    console.error('Follow-up email JSON parsing error:', e);
  }

  return emailData;
}

// Main scheduler job - generate follow-ups for emails sent 3 and 7 days ago
async function runSequenceJob(pool, openai) {
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
          openai,
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
          openai,
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

      // Rate limiting between OpenAI calls
      if (i < day3Result.rows.length - 1) {
        await delay(1000);
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
    // Call the API endpoint that handles queue processing
    const CampaignSendingService = require('./campaign-sending-service');
    const sendingService = new CampaignSendingService(pool);
    await sendingService.processSendingQueue();
  } catch (err) {
    console.error('[Scheduler] Sending queue processing error:', err);
  }
}

// Initialize scheduler
function initializeScheduler(pool, openai, schedule = '0 0 * * *') {
  console.log(`[Scheduler] Initializing email sequences with schedule: ${schedule}`);

  if (!cron.validate(schedule)) {
    console.error('[Scheduler] Invalid cron schedule:', schedule);
    return null;
  }

  // Main sequence job (daily)
  const sequenceTask = cron.schedule(schedule, () => {
    runSequenceJob(pool, openai);
  }, {
    scheduled: true,
    timezone: 'UTC'
  });

  // Campaign sending queue processor (every 5 minutes)
  const sendingTask = cron.schedule('*/5 * * * *', () => {
    processSendingQueue(pool);
  }, {
    scheduled: true,
    timezone: 'UTC'
  });

  console.log('[Scheduler] Email sequence scheduler initialized successfully');
  console.log('[Scheduler] Campaign sending queue processor initialized (every 5 minutes)');

  return {
    task: sequenceTask,
    sendingTask: sendingTask,
    runNow: () => runSequenceJob(pool, openai),
    processSendingQueueNow: () => processSendingQueue(pool)
  };
}

module.exports = { initializeScheduler, runSequenceJob, processSendingQueue };
