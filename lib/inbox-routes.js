/**
 * Inbox Routes
 *
 * Handles prospect replies with AI categorization:
 * - GET /api/inbox/replies — list all replies with filtering
 * - GET /api/inbox/replies/:id — get single reply
 * - PATCH /api/inbox/replies/:id/read — mark as read
 * - PATCH /api/inbox/replies/:id/archive — toggle archive
 * - POST /api/inbox/replies/:id/categorize — re-categorize with AI
 */

const { body, param, query, validationResult } = require('express-validator');
const ReplyResponseService = require('./reply-response-service');

function registerInboxRoutes(app, pool, authService) {
  const replyResponseService = new ReplyResponseService(pool);
  // Authenticate and extract user from JWT token
  async function authenticateUser(req) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    const decoded = authService.verifyToken(token);
    if (!decoded || !decoded.userId) return null;
    return { id: decoded.userId };
  }

  const requireAuth = async (req, res, next) => {
    try {
      const user = await authenticateUser(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      req.user = user;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };

  /**
   * GET /api/inbox/replies
   * List prospect replies with filtering and pagination
   * Query params: category, campaign_id, is_read, is_archived, limit, offset, sort
   */
  app.get('/api/inbox/replies', requireAuth, [
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('campaign_id').optional().isInt().toInt(),
    query('category').optional().isIn(['interested', 'not_interested', 'ooo', 'objection', 'uncategorized']),
    query('is_read').optional().isBoolean().toBoolean(),
    query('is_archived').optional().isBoolean().toBoolean(),
    query('sort').optional().isIn(['newest', 'oldest', 'confidence_high', 'confidence_low'])
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const limit = req.query.limit || 20;
      const offset = req.query.offset || 0;
      const { campaign_id, category, is_read, is_archived, sort } = req.query;

      let query = `
        SELECT
          pri.id,
          pri.prospect_id,
          pri.campaign_id,
          pri.recipient_email,
          pri.recipient_name,
          pri.reply_from_email,
          pri.reply_from_name,
          pri.reply_subject,
          pri.reply_body,
          pri.reply_received_at,
          pri.reply_category,
          pri.category_confidence,
          pri.original_email_subject,
          pri.is_read,
          pri.is_archived,
          pri.created_at
        FROM prospect_reply_inbox pri
        INNER JOIN campaigns c ON pri.campaign_id = c.id AND c.user_id = $1
        WHERE 1=1
      `;
      const params = [req.user.id];

      if (campaign_id) {
        query += ` AND campaign_id = $${params.length + 1}`;
        params.push(campaign_id);
      }

      if (category) {
        query += ` AND reply_category = $${params.length + 1}`;
        params.push(category);
      }

      if (is_read !== undefined) {
        query += ` AND is_read = $${params.length + 1}`;
        params.push(is_read);
      }

      if (is_archived !== undefined) {
        query += ` AND is_archived = $${params.length + 1}`;
        params.push(is_archived);
      }

      // Sorting
      if (sort === 'oldest') {
        query += ` ORDER BY reply_received_at ASC`;
      } else if (sort === 'confidence_high') {
        query += ` ORDER BY category_confidence DESC, reply_received_at DESC`;
      } else if (sort === 'confidence_low') {
        query += ` ORDER BY category_confidence ASC, reply_received_at DESC`;
      } else {
        query += ` ORDER BY reply_received_at DESC`;
      }

      query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      // Get total count
      let countQuery = `SELECT COUNT(*) as total FROM prospect_reply_inbox pri INNER JOIN campaigns c ON pri.campaign_id = c.id AND c.user_id = $1 WHERE 1=1`;
      const countParams = [req.user.id];

      if (campaign_id) {
        countQuery += ` AND campaign_id = $${countParams.length + 1}`;
        countParams.push(campaign_id);
      }
      if (category) {
        countQuery += ` AND reply_category = $${countParams.length + 1}`;
        countParams.push(category);
      }
      if (is_read !== undefined) {
        countQuery += ` AND is_read = $${countParams.length + 1}`;
        countParams.push(is_read);
      }
      if (is_archived !== undefined) {
        countQuery += ` AND is_archived = $${countParams.length + 1}`;
        countParams.push(is_archived);
      }

      const countResult = await pool.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].total);

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          total,
          limit,
          offset,
          has_more: offset + limit < total
        }
      });
    } catch (err) {
      console.error('Error fetching inbox replies:', err);
      res.status(500).json({ error: 'Failed to fetch replies' });
    }
  });

  /**
   * GET /api/inbox/replies/:id
   * Get single reply with full details
   */
  app.get('/api/inbox/replies/:id', requireAuth, [
    param('id').isInt()
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id } = req.params;

      const result = await pool.query(
        `SELECT pri.* FROM prospect_reply_inbox pri
         INNER JOIN campaigns c ON pri.campaign_id = c.id AND c.user_id = $1
         WHERE pri.id = $2`,
        [req.user.id, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Reply not found' });
      }

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (err) {
      console.error('Error fetching reply:', err);
      res.status(500).json({ error: 'Failed to fetch reply' });
    }
  });

  /**
   * PATCH /api/inbox/replies/:id/read
   * Mark reply as read/unread
   */
  app.patch('/api/inbox/replies/:id/read', requireAuth, [
    param('id').isInt(),
    body('is_read').isBoolean()
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id } = req.params;
      const { is_read } = req.body;

      const result = await pool.query(
        `UPDATE prospect_reply_inbox pri
         SET is_read = $1, updated_at = NOW()
         FROM campaigns c
         WHERE pri.campaign_id = c.id AND c.user_id = $2 AND pri.id = $3
         RETURNING pri.*`,
        [is_read, req.user.id, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Reply not found' });
      }

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (err) {
      console.error('Error updating read status:', err);
      res.status(500).json({ error: 'Failed to update reply' });
    }
  });

  /**
   * PATCH /api/inbox/replies/:id/archive
   * Toggle archive status
   */
  app.patch('/api/inbox/replies/:id/archive', requireAuth, [
    param('id').isInt(),
    body('is_archived').isBoolean()
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id } = req.params;
      const { is_archived } = req.body;

      const result = await pool.query(
        `UPDATE prospect_reply_inbox pri
         SET is_archived = $1, updated_at = NOW()
         FROM campaigns c
         WHERE pri.campaign_id = c.id AND c.user_id = $2 AND pri.id = $3
         RETURNING pri.*`,
        [is_archived, req.user.id, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Reply not found' });
      }

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (err) {
      console.error('Error updating archive status:', err);
      res.status(500).json({ error: 'Failed to update reply' });
    }
  });

  /**
   * POST /api/inbox/replies/:id/categorize
   * Re-categorize reply using AI
   */
  app.post('/api/inbox/replies/:id/categorize', requireAuth, [
    param('id').isInt()
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id } = req.params;

      // Fetch the reply (user-scoped)
      const replyResult = await pool.query(
        `SELECT pri.* FROM prospect_reply_inbox pri
         INNER JOIN campaigns c ON pri.campaign_id = c.id AND c.user_id = $1
         WHERE pri.id = $2`,
        [req.user.id, id]
      );

      if (replyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Reply not found' });
      }

      const reply = replyResult.rows[0];

      // Re-categorize using AI
      const categorization = await replyResponseService.categorizeReply(parseInt(id), req.user.id);

      // Fetch updated record
      const updateResult = await pool.query(
        `SELECT pri.* FROM prospect_reply_inbox pri
         INNER JOIN campaigns c ON pri.campaign_id = c.id AND c.user_id = $1
         WHERE pri.id = $2`,
        [req.user.id, id]
      );

      res.json({
        success: true,
        data: updateResult.rows[0]
      });
    } catch (err) {
      console.error('Error re-categorizing reply:', err);
      res.status(500).json({ error: 'Failed to categorize reply' });
    }
  });

  /**
   * GET /api/inbox/stats
   * Get inbox statistics (category counts, unread count)
   */
  app.get('/api/inbox/stats', requireAuth, async (req, res) => {
    try {
      const { campaign_id } = req.query;

      let query = `
        SELECT
          pri.reply_category,
          COUNT(*) as count,
          SUM(CASE WHEN pri.is_read = false THEN 1 ELSE 0 END) as unread_count
        FROM prospect_reply_inbox pri
        INNER JOIN campaigns c ON pri.campaign_id = c.id AND c.user_id = $1
        WHERE pri.is_archived = false
      `;
      const params = [req.user.id];

      if (campaign_id) {
        query += ` AND campaign_id = $${params.length + 1}`;
        params.push(campaign_id);
      }

      query += ` GROUP BY pri.reply_category`;

      const result = await pool.query(query, params);

      // Format response
      const stats = {
        total: 0,
        by_category: {},
        unread: 0
      };

      result.rows.forEach(row => {
        stats.total += row.count;
        stats.by_category[row.reply_category] = {
          count: row.count,
          unread: row.unread_count
        };
        stats.unread += row.unread_count;
      });

      res.json({
        success: true,
        data: stats
      });
    } catch (err) {
      console.error('Error fetching inbox stats:', err);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });
}

module.exports = {
  registerInboxRoutes
};
