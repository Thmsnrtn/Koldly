/**
 * Ecosystem Service
 *
 * Handles authentication for internal API calls between Koldly, AcreOS, and Apex Micro.
 * Uses ECOSYSTEM_SERVICE_KEY for shared-secret auth.
 * Enforces data isolation between acquisition programs.
 */

const crypto = require('crypto');

class EcosystemService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Validate ecosystem service key from request header.
   * Returns true if valid, false otherwise.
   * Uses timing-safe comparison to prevent timing attacks.
   */
  authenticateKey(req) {
    const key = req.headers['x-ecosystem-key'];
    const expectedKey = process.env.ECOSYSTEM_SERVICE_KEY;

    if (!key || !expectedKey) return false;

    try {
      const keyBuffer = Buffer.from(key, 'utf8');
      const expectedBuffer = Buffer.from(expectedKey, 'utf8');

      if (keyBuffer.length !== expectedBuffer.length) return false;
      return crypto.timingSafeEqual(keyBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Express middleware for ecosystem-authenticated routes.
   * Returns 401 with no info leak on failure.
   */
  middleware() {
    return (req, res, next) => {
      if (!this.authenticateKey(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      req.ecosystemAuthenticated = true;
      next();
    };
  }

  /**
   * Get acquisition program by name. Validates it exists and is active.
   */
  async getProgram(programName) {
    const result = await this.pool.query(
      'SELECT * FROM acquisition_programs WHERE program_name = $1',
      [programName]
    );
    return result.rows[0] || null;
  }

  /**
   * Create a campaign under an acquisition program.
   * Enforces isolation via isolation_key.
   */
  async createProgramCampaign(programName, prospects, campaignConfig = {}) {
    const program = await this.getProgram(programName);
    if (!program) throw new Error(`Unknown acquisition program: ${programName}`);
    if (program.status !== 'active') throw new Error(`Program ${programName} is not active`);

    const config = typeof program.config === 'string' ? JSON.parse(program.config) : program.config;
    const name = campaignConfig.name || `${program.target_product} Acquisition — ${new Date().toISOString().split('T')[0]}`;
    const description = campaignConfig.description || config.description || '';
    const icpDescription = campaignConfig.icp_description || config.icp || '';

    // Get or create system user for this program
    const systemUserId = await this._getSystemUser(program.isolation_key);

    // Create campaign with isolation key
    const campaignResult = await this.pool.query(`
      INSERT INTO campaigns (user_id, name, description, icp_description, status, isolation_key)
      VALUES ($1, $2, $3, $4, 'active', $5)
      RETURNING *
    `, [systemUserId, name, description, icpDescription, program.isolation_key]);

    const campaign = campaignResult.rows[0];

    // Import prospects if provided
    let imported = 0;
    if (prospects && prospects.length > 0) {
      for (const p of prospects) {
        if (!p.email) continue;
        try {
          await this.pool.query(`
            INSERT INTO prospects (campaign_id, email, first_name, last_name, company_name, title, source, status, fit_score)
            VALUES ($1, $2, $3, $4, $5, $6, 'ecosystem_api', 'discovered', 50)
            ON CONFLICT (campaign_id, email) DO NOTHING
          `, [
            campaign.id,
            p.email.trim().toLowerCase(),
            p.first_name || null,
            p.last_name || null,
            p.company || p.company_name || null,
            p.title || null
          ]);
          imported++;
        } catch {
          // Skip individual import errors
        }
      }
    }

    // Update program stats
    await this.pool.query(`
      UPDATE acquisition_programs
      SET total_campaigns = total_campaigns + 1,
          total_prospects = total_prospects + $1,
          updated_at = NOW()
      WHERE program_name = $2
    `, [imported, programName]);

    return {
      campaign_id: campaign.id,
      program: programName,
      isolation_key: program.isolation_key,
      prospects_imported: imported
    };
  }

  /**
   * Get campaign status for a program campaign (respects isolation)
   */
  async getCampaignStatus(campaignId) {
    const result = await this.pool.query(`
      SELECT
        c.id, c.name, c.status, c.isolation_key, c.created_at,
        (SELECT COUNT(*) FROM prospects WHERE campaign_id = c.id) as total_prospects,
        (SELECT COUNT(*) FROM generated_emails WHERE campaign_id = c.id AND status = 'pending_approval') as pending_approval,
        (SELECT COUNT(*) FROM generated_emails WHERE campaign_id = c.id AND status = 'approved') as approved,
        (SELECT COUNT(*) FROM campaign_sending_queue WHERE campaign_id = c.id AND status = 'sent') as sent,
        (SELECT COUNT(*) FROM prospect_reply_inbox WHERE campaign_id = c.id) as replies
      FROM campaigns c
      WHERE c.id = $1 AND c.isolation_key IS NOT NULL
    `, [campaignId]);

    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  /**
   * Get aggregated dashboard data across all acquisition programs
   */
  async getDashboardData() {
    const programs = await this.pool.query('SELECT * FROM acquisition_programs ORDER BY program_name');

    const dashboard = {
      programs: [],
      totals: { campaigns: 0, prospects: 0, emails_sent: 0, replies: 0 }
    };

    for (const program of programs.rows) {
      // Get live stats from actual tables
      const stats = await this.pool.query(`
        SELECT
          COUNT(DISTINCT c.id) as campaigns,
          COALESCE(SUM(p_count.cnt), 0) as prospects,
          COALESCE(SUM(sent_count.cnt), 0) as emails_sent,
          COALESCE(SUM(reply_count.cnt), 0) as replies
        FROM campaigns c
        LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM prospects WHERE campaign_id = c.id) p_count ON true
        LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM campaign_sending_queue WHERE campaign_id = c.id AND status = 'sent') sent_count ON true
        LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM prospect_reply_inbox WHERE campaign_id = c.id) reply_count ON true
        WHERE c.isolation_key = $1
      `, [program.isolation_key]);

      const s = stats.rows[0];
      dashboard.programs.push({
        name: program.program_name,
        target_product: program.target_product,
        status: program.status,
        isolation_key: program.isolation_key,
        campaigns: parseInt(s.campaigns),
        prospects: parseInt(s.prospects),
        emails_sent: parseInt(s.emails_sent),
        replies: parseInt(s.replies)
      });

      dashboard.totals.campaigns += parseInt(s.campaigns);
      dashboard.totals.prospects += parseInt(s.prospects);
      dashboard.totals.emails_sent += parseInt(s.emails_sent);
      dashboard.totals.replies += parseInt(s.replies);
    }

    // Get churn risk distribution
    const churnDist = await this.pool.query(`
      SELECT churn_risk, COUNT(*) as count
      FROM engagement_scores
      GROUP BY churn_risk
    `);
    dashboard.churn_risk_distribution = {};
    for (const row of churnDist.rows) {
      dashboard.churn_risk_distribution[row.churn_risk] = parseInt(row.count);
    }

    // Get overall user stats
    const userStats = await this.pool.query(`
      SELECT
        COUNT(*) as total_users,
        COUNT(CASE WHEN activated_at IS NOT NULL THEN 1 END) as activated_users,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as new_users_7d
      FROM users
    `);
    dashboard.users = userStats.rows[0];

    return dashboard;
  }

  /**
   * Get or create a system user for a given isolation key.
   * System users own ecosystem-created campaigns.
   */
  async _getSystemUser(isolationKey) {
    const email = `system+${isolationKey}@koldly.com`;
    const existing = await this.pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (existing.rows.length > 0) return existing.rows[0].id;

    // Create system user (no password — cannot login)
    const result = await this.pool.query(
      `INSERT INTO users (email, name, onboarding_completed, is_admin)
       VALUES ($1, $2, true, false)
       RETURNING id`,
      [email, `System (${isolationKey})`]
    );

    return result.rows[0].id;
  }
}

module.exports = EcosystemService;
