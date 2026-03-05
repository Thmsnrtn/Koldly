/**
 * Migration: LinkedIn Outreach and Multi-channel Support
 *
 * Adds linkedin_tasks table for LinkedIn outreach (connection requests,
 * InMails, messages) and adds a channel abstraction to approval queue.
 */
module.exports = {
  name: 'add_linkedin_and_multichannel',
  up: async (client) => {

    // ---- LinkedIn Tasks ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS linkedin_tasks (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_type VARCHAR(50) NOT NULL DEFAULT 'connect_request',
          -- connect_request | inmail | message | follow_up
        content TEXT NOT NULL,
        personalization_hook TEXT,
        char_count INTEGER,
        linkedin_url TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'pending_approval',
          -- pending_approval | approved | rejected | queued_for_extension | sent | failed
        rejection_reason TEXT,
        error_message TEXT,
        approved_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        phantombuster_launch_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS linkedin_tasks_campaign_idx ON linkedin_tasks(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS linkedin_tasks_prospect_idx ON linkedin_tasks(prospect_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS linkedin_tasks_user_idx ON linkedin_tasks(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS linkedin_tasks_status_idx ON linkedin_tasks(status)`);

    // ---- LinkedIn Reply Inbox ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS linkedin_replies (
        id SERIAL PRIMARY KEY,
        linkedin_task_id INTEGER REFERENCES linkedin_tasks(id) ON DELETE SET NULL,
        prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        sender_linkedin_url TEXT,
        message_text TEXT,
        received_at TIMESTAMPTZ DEFAULT NOW(),
        category VARCHAR(50),
          -- interested | not_interested | ooo | objection | question | uncategorized
        ai_categorization JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS linkedin_replies_prospect_idx ON linkedin_replies(prospect_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS linkedin_replies_status_idx ON linkedin_replies(category)`);

    // ---- Add channel column to approval-adjacent tables ----
    // The approval service uses generated_emails for email and reply_drafts for replies.
    // LinkedIn tasks have their own table. For the API and iOS app, we track
    // multi-channel pending counts via a unified view (defined below).

    // Unified approval queue view across channels
    await client.query(`
      CREATE OR REPLACE VIEW unified_approval_queue AS
      SELECT
        ge.id, 'email' as channel, ge.campaign_id, ge.prospect_id,
        c.user_id, ge.status, ge.created_at,
        ge.subject_line as title,
        ge.recipient_email as target,
        p.company_name
      FROM generated_emails ge
      JOIN campaigns c ON ge.campaign_id = c.id
      JOIN prospects p ON ge.prospect_id = p.id
      WHERE ge.status = 'pending_approval'

      UNION ALL

      SELECT
        lt.id, 'linkedin' as channel, lt.campaign_id, lt.prospect_id,
        lt.user_id, lt.status, lt.created_at,
        CONCAT('LinkedIn ', lt.task_type) as title,
        lt.linkedin_url as target,
        p.company_name
      FROM linkedin_tasks lt
      JOIN prospects p ON lt.prospect_id = p.id
      WHERE lt.status = 'pending_approval'

      UNION ALL

      SELECT
        rd.id, 'reply_draft' as channel, rd.campaign_id, rd.prospect_id,
        c.user_id, rd.status, rd.created_at,
        CONCAT('Reply: ', rd.reply_category) as title,
        NULL as target,
        p.company_name
      FROM reply_drafts rd
      JOIN campaigns c ON rd.campaign_id = c.id
      JOIN prospects p ON rd.prospect_id = p.id
      WHERE rd.status = 'pending_approval'
    `);

    console.log('[Migration] LinkedIn tasks and multi-channel support created');
  },

  down: async (client) => {
    await client.query(`DROP VIEW IF EXISTS unified_approval_queue`);
    await client.query(`DROP TABLE IF EXISTS linkedin_replies`);
    await client.query(`DROP TABLE IF EXISTS linkedin_tasks`);
  }
};
