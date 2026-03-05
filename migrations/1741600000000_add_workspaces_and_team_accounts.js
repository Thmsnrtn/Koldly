/**
 * Migration: Workspaces and Team Accounts
 *
 * Adds workspace model so multiple users can collaborate on campaigns.
 * v1: owner + up to 2 members (Growth) or unlimited (Scale).
 *
 * Strategy: Create one workspace per existing user, then campaigns
 * gain a workspace_id column. user_id is kept for backward compatibility
 * until Phase 2 completes the full migration.
 */
module.exports = {
  name: 'add_workspaces_and_team_accounts',
  up: async (client) => {

    // ---- Workspaces ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan VARCHAR(50) DEFAULT 'free',
        stripe_customer_id VARCHAR(255),
        member_limit INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces(owner_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS workspaces_stripe_idx ON workspaces(stripe_customer_id)`);

    // ---- Workspace Members ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_members (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) NOT NULL DEFAULT 'member',
          -- roles: owner | admin | member | viewer
        invited_by INTEGER REFERENCES users(id),
        invite_token VARCHAR(64),
        invite_email VARCHAR(255),
        invite_expires_at TIMESTAMPTZ,
        accepted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(workspace_id, user_id)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS workspace_members_workspace_idx ON workspace_members(workspace_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS workspace_members_token_idx ON workspace_members(invite_token)`);

    // ---- Workspace Invitations ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_invitations (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        invited_by INTEGER NOT NULL REFERENCES users(id),
        email VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'member',
        token VARCHAR(64) NOT NULL UNIQUE,
        status VARCHAR(50) DEFAULT 'pending',
          -- pending | accepted | expired | revoked
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
        accepted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS invitations_workspace_idx ON workspace_invitations(workspace_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS invitations_token_idx ON workspace_invitations(token)`);
    await client.query(`CREATE INDEX IF NOT EXISTS invitations_email_idx ON workspace_invitations(email)`);

    // ---- Add workspace_id to campaigns (Phase 1: optional, alongside user_id) ----
    await client.query(`
      ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS campaigns_workspace_idx ON campaigns(workspace_id)`);

    // ---- Backfill: create one workspace per existing user ----
    // Only run if workspaces table is empty (idempotent)
    await client.query(`
      INSERT INTO workspaces (name, owner_user_id, plan, created_at, updated_at)
      SELECT
        COALESCE(name, email, 'My Workspace') as name,
        id as owner_user_id,
        COALESCE(subscription_plan, 'free') as plan,
        created_at,
        created_at
      FROM users
      WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE owner_user_id = users.id)
    `);

    // ---- Backfill: add owner as member of their workspace ----
    await client.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role, accepted_at)
      SELECT w.id, w.owner_user_id, 'owner', w.created_at
      FROM workspaces w
      WHERE NOT EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = w.id AND wm.user_id = w.owner_user_id
      )
    `);

    // ---- Backfill: link existing campaigns to their owner's workspace ----
    await client.query(`
      UPDATE campaigns c
      SET workspace_id = w.id
      FROM workspaces w
      WHERE w.owner_user_id = c.user_id
      AND c.workspace_id IS NULL
    `);

    // ---- Add prospect data source fields (used by enrichment service) ----
    await client.query(`
      ALTER TABLE prospects
      ADD COLUMN IF NOT EXISTS contact_first_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS contact_last_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS contact_title VARCHAR(255),
      ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255),
      ADD COLUMN IF NOT EXISTS data_source VARCHAR(50) DEFAULT 'ai_brainstorm',
      ADD COLUMN IF NOT EXISTS is_ai_generated BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS apollo_person_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS apollo_org_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS email_verification_status VARCHAR(50),
      ADD COLUMN IF NOT EXISTS email_smtp_verified BOOLEAN DEFAULT FALSE
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS prospects_data_source_idx ON prospects(data_source)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prospects_contact_email_idx ON prospects(contact_email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prospects_is_ai_generated_idx ON prospects(is_ai_generated)`);

    console.log('[Migration] Workspaces and team accounts created');
  },

  down: async (client) => {
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS contact_first_name`);
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS contact_last_name`);
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS contact_title`);
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS contact_email`);
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS data_source`);
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS is_ai_generated`);
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS apollo_person_id`);
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS apollo_org_id`);
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS email_verification_status`);
    await client.query(`ALTER TABLE prospects DROP COLUMN IF EXISTS email_smtp_verified`);
    await client.query(`ALTER TABLE campaigns DROP COLUMN IF EXISTS workspace_id`);
    await client.query(`DROP TABLE IF EXISTS workspace_invitations`);
    await client.query(`DROP TABLE IF EXISTS workspace_members`);
    await client.query(`DROP TABLE IF EXISTS workspaces`);
  }
};
