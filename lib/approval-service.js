/**
 * Approval Queue Service
 *
 * Central hub for the autonomous pipeline. All AI-generated content flows
 * through the approval queue before being sent.
 *
 * Handles: email approvals, reply draft approvals, bulk actions, edits.
 */

class ApprovalService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Get all pending items for a user's approval queue
   */
  async getQueue(userId, filters = {}) {
    const { type, campaign_id, page = 1, limit = 50 } = filters;
    const offset = (page - 1) * limit;

    const items = [];

    // Pending emails
    if (!type || type === 'email') {
      const emailQuery = `
        SELECT
          ge.id, ge.prospect_id, ge.campaign_id, ge.recipient_name, ge.recipient_email,
          ge.subject_line, ge.email_body, ge.personalization_notes, ge.status, ge.created_at,
          p.company_name, p.industry, p.website, p.fit_score,
          c.name as campaign_name,
          'email' as item_type
        FROM generated_emails ge
        JOIN prospects p ON ge.prospect_id = p.id
        JOIN campaigns c ON ge.campaign_id = c.id
        WHERE c.user_id = $1
          AND ge.status = 'pending_approval'
          ${campaign_id ? 'AND ge.campaign_id = $3' : ''}
        ORDER BY ge.created_at DESC
        LIMIT $2 OFFSET ${offset}
      `;
      const params = campaign_id ? [userId, limit, campaign_id] : [userId, limit];
      const emailResult = await this.pool.query(emailQuery, params);
      items.push(...emailResult.rows);
    }

    // Pending reply drafts
    if (!type || type === 'reply') {
      const replyQuery = `
        SELECT
          rd.id, rd.reply_id, rd.prospect_id, rd.campaign_id,
          rd.draft_subject, rd.draft_body, rd.reply_category, rd.status, rd.created_at,
          p.company_name, p.industry, p.website, p.fit_score,
          c.name as campaign_name,
          pri.sender_email as reply_from,
          pri.subject as original_subject,
          pri.body_text as original_body,
          'reply_draft' as item_type
        FROM reply_drafts rd
        JOIN prospects p ON rd.prospect_id = p.id
        JOIN campaigns c ON rd.campaign_id = c.id
        LEFT JOIN prospect_reply_inbox pri ON rd.reply_id = pri.id
        WHERE c.user_id = $1
          AND rd.status = 'pending_approval'
          ${campaign_id ? 'AND rd.campaign_id = $3' : ''}
        ORDER BY rd.created_at DESC
        LIMIT $2 OFFSET ${offset}
      `;
      const params = campaign_id ? [userId, limit, campaign_id] : [userId, limit];
      const replyResult = await this.pool.query(replyQuery, params);
      items.push(...replyResult.rows);
    }

    // Sort combined items by created_at
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Get counts
    const counts = await this.getQueueCounts(userId);

    return {
      items: items.slice(0, limit),
      counts,
      page,
      limit
    };
  }

  /**
   * Get queue counts by type
   */
  async getQueueCounts(userId) {
    const emailCount = await this.pool.query(`
      SELECT COUNT(*) as count
      FROM generated_emails ge
      JOIN campaigns c ON ge.campaign_id = c.id
      WHERE c.user_id = $1 AND ge.status = 'pending_approval'
    `, [userId]);

    const replyCount = await this.pool.query(`
      SELECT COUNT(*) as count
      FROM reply_drafts rd
      JOIN campaigns c ON rd.campaign_id = c.id
      WHERE c.user_id = $1 AND rd.status = 'pending_approval'
    `, [userId]);

    return {
      emails: parseInt(emailCount.rows[0].count),
      replies: parseInt(replyCount.rows[0].count),
      total: parseInt(emailCount.rows[0].count) + parseInt(replyCount.rows[0].count)
    };
  }

  /**
   * Approve a single email
   */
  async approveEmail(emailId, userId) {
    const result = await this.pool.query(`
      UPDATE generated_emails ge SET
        status = 'approved',
        updated_at = NOW()
      FROM campaigns c
      WHERE ge.campaign_id = c.id
        AND ge.id = $1
        AND c.user_id = $2
        AND ge.status = 'pending_approval'
      RETURNING ge.id, ge.prospect_id
    `, [emailId, userId]);

    if (result.rows.length === 0) throw new Error('Email not found or already processed');

    // Update prospect status
    await this.pool.query(
      "UPDATE prospects SET status = 'approved' WHERE id = $1",
      [result.rows[0].prospect_id]
    );

    return { id: emailId, status: 'approved' };
  }

  /**
   * Edit and approve an email
   */
  async editAndApproveEmail(emailId, userId, edits) {
    const { subject, body, recipient_email } = edits;

    const result = await this.pool.query(`
      UPDATE generated_emails ge SET
        subject_line = COALESCE($3, ge.subject_line),
        email_body = COALESCE($4, ge.email_body),
        recipient_email = COALESCE($5, ge.recipient_email),
        status = 'approved',
        updated_at = NOW()
      FROM campaigns c
      WHERE ge.campaign_id = c.id
        AND ge.id = $1
        AND c.user_id = $2
        AND ge.status = 'pending_approval'
      RETURNING ge.id, ge.prospect_id
    `, [emailId, userId, subject || null, body || null, recipient_email || null]);

    if (result.rows.length === 0) throw new Error('Email not found or already processed');

    await this.pool.query(
      "UPDATE prospects SET status = 'approved' WHERE id = $1",
      [result.rows[0].prospect_id]
    );

    return { id: emailId, status: 'approved' };
  }

  /**
   * Reject an email
   */
  async rejectEmail(emailId, userId, reason = '') {
    const result = await this.pool.query(`
      UPDATE generated_emails ge SET
        status = 'rejected',
        personalization_notes = CASE WHEN $3 != '' THEN $3 ELSE ge.personalization_notes END,
        updated_at = NOW()
      FROM campaigns c
      WHERE ge.campaign_id = c.id
        AND ge.id = $1
        AND c.user_id = $2
        AND ge.status = 'pending_approval'
      RETURNING ge.id, ge.prospect_id
    `, [emailId, userId, reason]);

    if (result.rows.length === 0) throw new Error('Email not found or already processed');

    // Revert prospect status so it can be re-processed
    await this.pool.query(
      "UPDATE prospects SET status = 'researched' WHERE id = $1",
      [result.rows[0].prospect_id]
    );

    return { id: emailId, status: 'rejected' };
  }

  /**
   * Bulk approve emails
   */
  async bulkApproveEmails(emailIds, userId) {
    const result = await this.pool.query(`
      UPDATE generated_emails ge SET
        status = 'approved',
        updated_at = NOW()
      FROM campaigns c
      WHERE ge.campaign_id = c.id
        AND ge.id = ANY($1)
        AND c.user_id = $2
        AND ge.status = 'pending_approval'
      RETURNING ge.id, ge.prospect_id
    `, [emailIds, userId]);

    // Update prospect statuses
    const prospectIds = result.rows.map(r => r.prospect_id);
    if (prospectIds.length > 0) {
      await this.pool.query(
        "UPDATE prospects SET status = 'approved' WHERE id = ANY($1)",
        [prospectIds]
      );
    }

    return { approved: result.rows.length, ids: result.rows.map(r => r.id) };
  }

  /**
   * Approve a reply draft
   */
  async approveReplyDraft(draftId, userId) {
    const result = await this.pool.query(`
      UPDATE reply_drafts rd SET
        status = 'approved',
        updated_at = NOW()
      FROM campaigns c
      WHERE rd.campaign_id = c.id
        AND rd.id = $1
        AND c.user_id = $2
        AND rd.status = 'pending_approval'
      RETURNING rd.id
    `, [draftId, userId]);

    if (result.rows.length === 0) throw new Error('Reply draft not found or already processed');

    return { id: draftId, status: 'approved' };
  }

  /**
   * Edit and approve a reply draft
   */
  async editAndApproveReplyDraft(draftId, userId, edits) {
    const { subject, body } = edits;

    const result = await this.pool.query(`
      UPDATE reply_drafts rd SET
        draft_subject = COALESCE($3, rd.draft_subject),
        draft_body = COALESCE($4, rd.draft_body),
        status = 'approved',
        updated_at = NOW()
      FROM campaigns c
      WHERE rd.campaign_id = c.id
        AND rd.id = $1
        AND c.user_id = $2
        AND rd.status = 'pending_approval'
      RETURNING rd.id
    `, [draftId, userId, subject || null, body || null]);

    if (result.rows.length === 0) throw new Error('Reply draft not found or already processed');

    return { id: draftId, status: 'approved' };
  }

  /**
   * Reject a reply draft
   */
  async rejectReplyDraft(draftId, userId, reason = '') {
    const result = await this.pool.query(`
      UPDATE reply_drafts rd SET
        status = 'rejected',
        rejection_reason = $3,
        updated_at = NOW()
      FROM campaigns c
      WHERE rd.campaign_id = c.id
        AND rd.id = $1
        AND c.user_id = $2
        AND rd.status = 'pending_approval'
      RETURNING rd.id
    `, [draftId, userId, reason]);

    if (result.rows.length === 0) throw new Error('Reply draft not found or already processed');

    return { id: draftId, status: 'rejected' };
  }
}

module.exports = ApprovalService;
