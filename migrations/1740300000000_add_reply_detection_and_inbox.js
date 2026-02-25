module.exports = {
  name: 'add_reply_detection_and_inbox',
  up: async (client) => {
    // Prospect replies with categorization
    // Tracks all prospect replies and auto-categorizes them
    await client.query(`
      CREATE TABLE IF NOT EXISTS prospect_reply_inbox (
        id SERIAL PRIMARY KEY,
        prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        generated_email_id INTEGER REFERENCES generated_emails(id) ON DELETE SET NULL,
        recipient_email VARCHAR(255) NOT NULL,
        recipient_name VARCHAR(255),
        reply_from_email VARCHAR(255) NOT NULL,
        reply_from_name VARCHAR(255),
        reply_subject VARCHAR(255),
        reply_body TEXT,
        reply_received_at TIMESTAMPTZ NOT NULL,
        reply_category VARCHAR(50) DEFAULT 'uncategorized',
        category_confidence DECIMAL(3, 2) DEFAULT 1.0,
        original_email_subject VARCHAR(255),
        original_email_snippet TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        is_archived BOOLEAN DEFAULT FALSE,
        notes TEXT,
        contacted_at TIMESTAMPTZ,
        sequence_halted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // CSV import history - tracks prospect imports with metadata
    await client.query(`
      CREATE TABLE IF NOT EXISTS csv_imports (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        filename VARCHAR(255) NOT NULL,
        total_rows INTEGER,
        imported_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        duplicate_count INTEGER DEFAULT 0,
        column_mapping JSONB,
        status VARCHAR(50) DEFAULT 'pending',
        error_log TEXT,
        imported_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // CSV import rows - individual rows from import with validation status
    await client.query(`
      CREATE TABLE IF NOT EXISTS csv_import_rows (
        id SERIAL PRIMARY KEY,
        import_id INTEGER NOT NULL REFERENCES csv_imports(id) ON DELETE CASCADE,
        prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
        row_number INTEGER,
        raw_data JSONB,
        status VARCHAR(50) DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for performance
    await client.query(`CREATE INDEX IF NOT EXISTS prospect_reply_inbox_campaign_id_idx ON prospect_reply_inbox(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prospect_reply_inbox_prospect_id_idx ON prospect_reply_inbox(prospect_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prospect_reply_inbox_category_idx ON prospect_reply_inbox(reply_category)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prospect_reply_inbox_received_at_idx ON prospect_reply_inbox(reply_received_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prospect_reply_inbox_is_read_idx ON prospect_reply_inbox(is_read)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prospect_reply_inbox_is_archived_idx ON prospect_reply_inbox(is_archived)`);

    await client.query(`CREATE INDEX IF NOT EXISTS csv_imports_user_id_idx ON csv_imports(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS csv_imports_campaign_id_idx ON csv_imports(campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS csv_imports_status_idx ON csv_imports(status)`);

    await client.query(`CREATE INDEX IF NOT EXISTS csv_import_rows_import_id_idx ON csv_import_rows(import_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS csv_import_rows_status_idx ON csv_import_rows(status)`);
  }
};