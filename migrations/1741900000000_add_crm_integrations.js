/**
 * Migration: CRM Integrations
 *
 * HubSpot and Salesforce two-way sync infrastructure.
 */
module.exports = {
  name: 'add_crm_integrations',
  up: async (client) => {

    // ---- CRM Integrations ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_integrations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL,
          -- hubspot | salesforce | pipedrive
        access_token TEXT,
        refresh_token TEXT,
        portal_id TEXT,
        instance_url TEXT,
        token_expires_at TIMESTAMPTZ,
        webhook_subscription_id TEXT,
        field_mappings JSONB DEFAULT '{}',
        sync_status VARCHAR(50) DEFAULT 'active',
        active BOOLEAN DEFAULT TRUE,
        connected_at TIMESTAMPTZ DEFAULT NOW(),
        last_sync_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, provider)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS crm_integrations_user_idx ON crm_integrations(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS crm_integrations_active_idx ON crm_integrations(user_id, active)`);

    // ---- CRM Events (inbound webhooks) ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        provider VARCHAR(50) NOT NULL,
        event_type VARCHAR(100),
        payload JSONB,
        processed BOOLEAN DEFAULT FALSE,
        processed_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS crm_events_user_idx ON crm_events(user_id, processed)`);
    await client.query(`CREATE INDEX IF NOT EXISTS crm_events_received_idx ON crm_events(received_at DESC)`);

    // ---- CRM Sync Log ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_sync_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        provider VARCHAR(50) NOT NULL,
        crm_contact_id TEXT,
        crm_deal_id TEXT,
        action VARCHAR(100),
          -- interested_reply | deal_stage_changed | deal_won | contact_updated
        sync_status VARCHAR(50) DEFAULT 'success',
        error_message TEXT,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS crm_sync_prospect_idx ON crm_sync_log(prospect_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS crm_sync_deal_idx ON crm_sync_log(crm_deal_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS crm_sync_user_idx ON crm_sync_log(user_id, synced_at DESC)`);

    // ---- Calendly Integration (for meeting booking) ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS calendly_integrations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        access_token TEXT,
        refresh_token TEXT,
        scheduling_url TEXT,
        event_type_uri TEXT,
        user_uri TEXT,
        webhook_id TEXT,
        active BOOLEAN DEFAULT TRUE,
        connected_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS calendly_user_idx ON calendly_integrations(user_id)`);

    // ---- Meeting Bookings (from Calendly webhook) ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS meeting_bookings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        calendly_event_uri TEXT UNIQUE,
        invitee_email VARCHAR(255),
        invitee_name VARCHAR(255),
        event_name VARCHAR(255),
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        status VARCHAR(50) DEFAULT 'active',
          -- active | cancelled | rescheduled
        source VARCHAR(50) DEFAULT 'calendly',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS meetings_user_idx ON meeting_bookings(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS meetings_prospect_idx ON meeting_bookings(prospect_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS meetings_start_idx ON meeting_bookings(start_time)`);

    console.log('[Migration] CRM integrations and meeting bookings created');
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS meeting_bookings`);
    await client.query(`DROP TABLE IF EXISTS calendly_integrations`);
    await client.query(`DROP TABLE IF EXISTS crm_sync_log`);
    await client.query(`DROP TABLE IF EXISTS crm_events`);
    await client.query(`DROP TABLE IF EXISTS crm_integrations`);
  }
};
