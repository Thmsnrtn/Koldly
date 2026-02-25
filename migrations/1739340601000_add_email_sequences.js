module.exports = {
  name: 'add_email_sequences',
  up: async (client) => {
    // Email sequences table - stores multi-touch email sequences
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_sequences (
        id SERIAL PRIMARY KEY,
        prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        original_email_id INTEGER NOT NULL REFERENCES generated_emails(id) ON DELETE CASCADE,
        sequence_type VARCHAR(50) NOT NULL DEFAULT 'standard',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Email sequence steps - stores individual emails in the sequence (Day 3, Day 7, etc)
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_sequence_steps (
        id SERIAL PRIMARY KEY,
        sequence_id INTEGER NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL,
        days_after_initial INTEGER NOT NULL,
        subject_line VARCHAR(255),
        email_body TEXT,
        personalization_notes TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for performance
    await client.query(`CREATE INDEX IF NOT EXISTS email_sequences_prospect_id_idx ON email_sequences(prospect_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS email_sequences_campaign_id_idx ON email_sequences(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS email_sequence_steps_sequence_id_idx ON email_sequence_steps(sequence_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS email_sequence_steps_status_idx ON email_sequence_steps(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS email_sequence_steps_created_at_idx ON email_sequence_steps(created_at)`);
  }
};
