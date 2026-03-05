/**
 * CRM Integration Service
 *
 * Bi-directional sync between Koldly and HubSpot / Salesforce.
 * Uses adapter pattern: HubSpotAdapter and SalesforceAdapter share
 * a common interface so the sync logic above them is provider-agnostic.
 *
 * Environment variables (HubSpot):
 *   HUBSPOT_CLIENT_ID       — OAuth app client ID
 *   HUBSPOT_CLIENT_SECRET   — OAuth app client secret
 *   HUBSPOT_REDIRECT_URI    — OAuth redirect URI
 *
 * Environment variables (Salesforce):
 *   SALESFORCE_CLIENT_ID    — Connected App consumer key
 *   SALESFORCE_CLIENT_SECRET
 *   SALESFORCE_REDIRECT_URI
 *
 * Data flow:
 *   1. Prospect reply categorized as 'interested'
 *      → CRM contact created/updated
 *      → CRM deal created at 'Discovery' stage
 *   2. Deal stage updated in CRM (via webhook)
 *      → Koldly stops outreach to that prospect
 *   3. Deal closed-won in CRM
 *      → Attribution recorded in Koldly analytics
 */

const https = require('https');
const http = require('http');

// ============================================================
// HTTP helpers
// ============================================================

function apiRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'http:' ? http : https;
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            return reject(new Error(`${options.hostname} ${res.statusCode}: ${data.slice(0, 300)}`));
          }
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error(`Parse error from ${options.hostname}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Request to ${options.hostname} timed out`)); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ============================================================
// HubSpot Adapter
// ============================================================

class HubSpotAdapter {
  constructor(accessToken, portalId) {
    this.accessToken = accessToken;
    this.portalId = portalId;
    this.baseHeaders = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  _req(method, path, body = null) {
    const payload = body ? JSON.stringify(body) : null;
    return apiRequest({
      hostname: 'api.hubapi.com',
      port: 443,
      path,
      method,
      headers: {
        ...this.baseHeaders,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, payload);
  }

  /**
   * Upsert a contact by email. Returns { id, created }.
   */
  async upsertContact(prospect) {
    const properties = {
      email: prospect.contact_email,
      firstname: prospect.contact_first_name || '',
      lastname: prospect.contact_last_name || '',
      jobtitle: prospect.contact_title || '',
      company: prospect.company_name || '',
      website: prospect.website || '',
      city: prospect.location || ''
    };

    // Check if contact exists
    try {
      const searchResult = await this._req('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [{
          filters: [{ propertyName: 'email', operator: 'EQ', value: prospect.contact_email }]
        }],
        properties: ['id', 'email']
      });

      if (searchResult.results && searchResult.results.length > 0) {
        const id = searchResult.results[0].id;
        await this._req('PATCH', `/crm/v3/objects/contacts/${id}`, { properties });
        return { id, created: false };
      }
    } catch (err) {
      // Continue to create if search fails
    }

    // Create new contact
    const result = await this._req('POST', '/crm/v3/objects/contacts', { properties });
    return { id: result.id, created: true };
  }

  /**
   * Create a deal for an interested prospect.
   */
  async createDeal(prospect, contact, campaignName) {
    const dealProperties = {
      dealname: `${prospect.company_name} — Koldly Outreach`,
      dealstage: 'appointmentscheduled', // Discovery stage
      pipeline: 'default',
      amount: '',
      closedate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      description: `Originated from Koldly campaign: ${campaignName}\nProspect replied interested.`
    };

    const dealResult = await this._req('POST', '/crm/v3/objects/deals', { properties: dealProperties });

    // Associate deal with contact
    if (contact && contact.id) {
      await this._req('PUT',
        `/crm/v3/objects/deals/${dealResult.id}/associations/contacts/${contact.id}/deal_to_contact`
      ).catch(() => {}); // Non-blocking
    }

    return { id: dealResult.id };
  }

  /**
   * Exchange OAuth code for tokens.
   */
  static async exchangeCode(code) {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.HUBSPOT_CLIENT_ID,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: process.env.HUBSPOT_REDIRECT_URI,
      code
    });
    const body = params.toString();
    const result = await apiRequest({
      hostname: 'api.hubapi.com',
      port: 443,
      path: '/oauth/v1/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);
    return result;
  }

  /**
   * Refresh an access token using a refresh token.
   */
  static async refreshToken(refreshToken) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.HUBSPOT_CLIENT_ID,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: process.env.HUBSPOT_REDIRECT_URI,
      refresh_token: refreshToken
    });
    const body = params.toString();
    return apiRequest({
      hostname: 'api.hubapi.com',
      port: 443,
      path: '/oauth/v1/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);
  }

  /**
   * Subscribe to webhook events for this portal.
   */
  async subscribeWebhooks(appId, webhookUrl) {
    const subscriptions = [
      { eventType: 'deal.propertyChange', propertyName: 'dealstage', active: true },
      { eventType: 'deal.creation', active: true }
    ];
    return this._req('PUT', `/webhooks/v3/${appId}/subscriptions`, { webhookUrl, subscriptions });
  }
}

// ============================================================
// Salesforce Adapter
// ============================================================

class SalesforceAdapter {
  constructor(accessToken, instanceUrl) {
    this.accessToken = accessToken;
    this.instanceUrl = instanceUrl;
    const url = new URL(instanceUrl);
    this.hostname = url.hostname;
  }

  _req(method, path, body = null) {
    const payload = body ? JSON.stringify(body) : null;
    return apiRequest({
      hostname: this.hostname,
      port: 443,
      path: `/services/data/v58.0${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, payload);
  }

  async upsertContact(prospect) {
    if (!prospect.contact_email) throw new Error('Email required for Salesforce contact');

    // Query for existing contact
    const soql = encodeURIComponent(`SELECT Id FROM Contact WHERE Email = '${prospect.contact_email}' LIMIT 1`);
    const queryResult = await this._req('GET', `/query?q=${soql}`);

    if (queryResult.records && queryResult.records.length > 0) {
      const id = queryResult.records[0].Id;
      await this._req('PATCH', `/sobjects/Contact/${id}`, {
        FirstName: prospect.contact_first_name || '',
        LastName: prospect.contact_last_name || 'Unknown',
        Title: prospect.contact_title || '',
        AccountName: prospect.company_name || ''
      });
      return { id, created: false };
    }

    const result = await this._req('POST', '/sobjects/Contact', {
      Email: prospect.contact_email,
      FirstName: prospect.contact_first_name || '',
      LastName: prospect.contact_last_name || 'Unknown',
      Title: prospect.contact_title || '',
      Company: prospect.company_name || ''
    });
    return { id: result.id, created: true };
  }

  async createDeal(prospect, contact, campaignName) {
    const result = await this._req('POST', '/sobjects/Opportunity', {
      Name: `${prospect.company_name} — Koldly Outreach`,
      StageName: 'Prospecting',
      CloseDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      Description: `Originated from Koldly campaign: ${campaignName}`,
      ...(contact && contact.id ? { ContactId: contact.id } : {})
    });
    return { id: result.id };
  }

  static async exchangeCode(code) {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.SALESFORCE_CLIENT_ID,
      client_secret: process.env.SALESFORCE_CLIENT_SECRET,
      redirect_uri: process.env.SALESFORCE_REDIRECT_URI,
      code
    });
    const body = params.toString();
    return apiRequest({
      hostname: 'login.salesforce.com',
      port: 443,
      path: '/services/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);
  }
}

// ============================================================
// CRM Service (provider-agnostic orchestration)
// ============================================================

class CRMService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Get an adapter for a user's connected CRM.
   * Handles token refresh automatically.
   */
  async _getAdapter(userId) {
    const result = await this.pool.query(
      `SELECT * FROM crm_integrations WHERE user_id = $1 AND active = TRUE ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) return null;
    const integration = result.rows[0];

    // Check if token needs refresh
    let accessToken = integration.access_token;
    if (integration.token_expires_at && new Date(integration.token_expires_at) < new Date(Date.now() + 300000)) {
      try {
        let refreshed;
        if (integration.provider === 'hubspot') {
          refreshed = await HubSpotAdapter.refreshToken(integration.refresh_token);
        }
        // Salesforce tokens are long-lived in production; skip refresh for MVP
        if (refreshed) {
          accessToken = refreshed.access_token;
          await this.pool.query(
            `UPDATE crm_integrations
             SET access_token = $1, token_expires_at = NOW() + INTERVAL '${Math.floor((refreshed.expires_in || 1800) / 60)} minutes'
             WHERE id = $2`,
            [accessToken, integration.id]
          );
        }
      } catch (err) {
        console.warn('[CRM] Token refresh failed:', err.message);
      }
    }

    if (integration.provider === 'hubspot') {
      return { adapter: new HubSpotAdapter(accessToken, integration.portal_id), integration };
    } else if (integration.provider === 'salesforce') {
      return { adapter: new SalesforceAdapter(accessToken, integration.instance_url), integration };
    }

    return null;
  }

  /**
   * Called when a prospect reply is categorized as 'interested'.
   * Creates/updates CRM contact and creates a deal.
   * Triggers sequence halt for this prospect.
   */
  async handleInterestedReply(prospectId, userId, campaignId) {
    const adapterResult = await this._getAdapter(userId);
    if (!adapterResult) return { skipped: 'no_crm_connected' };

    const { adapter } = adapterResult;

    // Get prospect data
    const prospectResult = await this.pool.query(
      `SELECT p.*, c.name as campaign_name FROM prospects p
       JOIN campaigns c ON p.campaign_id = c.id
       WHERE p.id = $1`,
      [prospectId]
    );

    if (prospectResult.rows.length === 0) return { error: 'Prospect not found' };
    const prospect = prospectResult.rows[0];

    if (!prospect.contact_email) {
      return { skipped: 'no_email', company: prospect.company_name };
    }

    let contact, deal;
    try {
      contact = await adapter.upsertContact(prospect);
      deal = await adapter.createDeal(prospect, contact, prospect.campaign_name);

      // Record the CRM sync
      await this.pool.query(
        `INSERT INTO crm_sync_log (user_id, prospect_id, campaign_id, provider, crm_contact_id, crm_deal_id, action, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'interested_reply', NOW())`,
        [userId, prospectId, campaignId, adapterResult.integration.provider, contact.id, deal.id]
      );

      // Halt outreach sequences for this prospect
      await this.pool.query(
        `UPDATE campaign_sending_queue
         SET status = 'halted'
         WHERE prospect_id = $1 AND campaign_id = $2 AND status = 'pending'`,
        [prospectId, campaignId]
      );

      console.info(`[CRM] Created deal for ${prospect.company_name} in ${adapterResult.integration.provider}`);
      return { success: true, contact, deal, provider: adapterResult.integration.provider };
    } catch (err) {
      console.error('[CRM] handleInterestedReply failed:', err.message);
      return { error: err.message };
    }
  }

  /**
   * Process inbound CRM webhook (deal stage changed, deal closed, etc.)
   */
  async processWebhookEvent(provider, event, userId) {
    try {
      await this.pool.query(
        `INSERT INTO crm_events (user_id, provider, event_type, payload, received_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [userId, provider, event.type || 'unknown', JSON.stringify(event)]
      );

      // Deal won → mark prospect as converted
      if (event.type === 'deal.propertyChange' && event.propertyName === 'dealstage') {
        const wonStages = ['closedwon', 'Closed Won', '9'];
        if (wonStages.includes(event.propertyValue)) {
          // Find prospect linked to this deal
          const syncResult = await this.pool.query(
            `SELECT prospect_id FROM crm_sync_log WHERE crm_deal_id = $1 LIMIT 1`,
            [String(event.objectId)]
          );
          if (syncResult.rows[0]) {
            await this.pool.query(
              `UPDATE prospects SET status = 'converted' WHERE id = $1`,
              [syncResult.rows[0].prospect_id]
            );
          }
        }
      }
    } catch (err) {
      console.error('[CRM] Webhook processing failed:', err.message);
    }
  }

  /**
   * OAuth callback: exchange code for tokens and store integration.
   */
  async completeOAuth(userId, provider, code) {
    let tokens, portalId, instanceUrl;

    if (provider === 'hubspot') {
      tokens = await HubSpotAdapter.exchangeCode(code);
      portalId = tokens.hub_id || tokens.hub_domain;
    } else if (provider === 'salesforce') {
      tokens = await SalesforceAdapter.exchangeCode(code);
      instanceUrl = tokens.instance_url;
    } else {
      throw new Error(`Unknown CRM provider: ${provider}`);
    }

    const expiresIn = tokens.expires_in ? tokens.expires_in : 1800;

    await this.pool.query(
      `INSERT INTO crm_integrations
       (user_id, provider, access_token, refresh_token, portal_id, instance_url,
        token_expires_at, active, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '${Math.floor(expiresIn / 60)} minutes', TRUE, NOW())
       ON CONFLICT (user_id, provider) DO UPDATE
       SET access_token = $3, refresh_token = $4, portal_id = $5, instance_url = $6,
           token_expires_at = NOW() + INTERVAL '${Math.floor(expiresIn / 60)} minutes',
           active = TRUE, connected_at = NOW()`,
      [userId, provider, tokens.access_token, tokens.refresh_token || null, portalId || null, instanceUrl || null]
    );

    return { success: true, provider };
  }

  /**
   * Disconnect a CRM integration.
   */
  async disconnect(userId, provider) {
    await this.pool.query(
      `UPDATE crm_integrations SET active = FALSE WHERE user_id = $1 AND provider = $2`,
      [userId, provider]
    );
  }

  /**
   * Get integration status for a user.
   */
  async getIntegrations(userId) {
    const result = await this.pool.query(
      `SELECT provider, active, connected_at, portal_id, instance_url
       FROM crm_integrations WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  }
}

module.exports = { CRMService, HubSpotAdapter, SalesforceAdapter };
