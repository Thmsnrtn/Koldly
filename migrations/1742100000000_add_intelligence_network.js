/**
 * Migration: Prospect Intelligence Network (Tier 3)
 *
 * Opt-in performance intelligence across Koldly users.
 * All data is anonymized and aggregated — no raw email content stored.
 *
 * Tables:
 *   - intelligence_opt_ins: User opt-in records
 *   - benchmark_data: Aggregated performance by ICP attributes
 *   - intelligence_signals: Anonymized performance events (input for benchmarks)
 */
module.exports = {
  name: 'add_intelligence_network',
  up: async (client) => {

    // ---- Network Opt-Ins ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS intelligence_opt_ins (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        opted_in BOOLEAN NOT NULL DEFAULT FALSE,
        opted_in_at TIMESTAMPTZ,
        opted_out_at TIMESTAMPTZ,
        data_sharing_level VARCHAR(50) DEFAULT 'aggregate',
          -- aggregate (performance metrics only) | none
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ---- Anonymized Performance Signals ----
    // One record per email sent (opt-in users only).
    // No personally identifiable information — no email addresses, no body content.
    await client.query(`
      CREATE TABLE IF NOT EXISTS intelligence_signals (
        id SERIAL PRIMARY KEY,
        -- ICP attributes (anonymized bucketing)
        icp_industry VARCHAR(100),
        icp_company_size_bucket VARCHAR(50),
          -- '1-50' | '51-200' | '201-1000' | '1000+'
        icp_geography VARCHAR(100),
        icp_job_title_category VARCHAR(100),
          -- 'C-Suite' | 'VP' | 'Director' | 'Manager' | 'IC'
        -- Email attributes (content hashed or bucketed)
        subject_word_count INTEGER,
        body_word_count INTEGER,
        email_angle VARCHAR(100),
          -- 'roi' | 'pain' | 'social_proof' | 'question' | 'story'
        has_personalization BOOLEAN,
        sequence_step INTEGER DEFAULT 1,
        -- Outcome (the value of this data)
        opened BOOLEAN DEFAULT FALSE,
        replied BOOLEAN DEFAULT FALSE,
        reply_category VARCHAR(50),
        -- Metadata
        sent_week DATE, -- Week of the year (not exact date)
        data_source VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS signals_industry_idx ON intelligence_signals(icp_industry)`);
    await client.query(`CREATE INDEX IF NOT EXISTS signals_angle_idx ON intelligence_signals(email_angle)`);
    await client.query(`CREATE INDEX IF NOT EXISTS signals_week_idx ON intelligence_signals(sent_week DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS signals_outcome_idx ON intelligence_signals(replied, opened)`);

    // ---- Benchmark Data (aggregated weekly) ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS benchmark_data (
        id SERIAL PRIMARY KEY,
        -- Dimensions
        icp_industry VARCHAR(100),
        icp_company_size_bucket VARCHAR(50),
        icp_job_title_category VARCHAR(100),
        email_angle VARCHAR(100),
        sequence_step INTEGER,
        -- Metrics (computed from intelligence_signals)
        sample_size INTEGER DEFAULT 0,
        open_count INTEGER DEFAULT 0,
        reply_count INTEGER DEFAULT 0,
        interested_count INTEGER DEFAULT 0,
        open_rate DECIMAL(5,4) DEFAULT 0,
        reply_rate DECIMAL(5,4) DEFAULT 0,
        interested_rate DECIMAL(5,4) DEFAULT 0,
        -- Period
        week_start DATE NOT NULL,
        computed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(icp_industry, icp_company_size_bucket, icp_job_title_category,
               email_angle, sequence_step, week_start)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS benchmarks_industry_idx ON benchmark_data(icp_industry)`);
    await client.query(`CREATE INDEX IF NOT EXISTS benchmarks_angle_idx ON benchmark_data(email_angle, reply_rate DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS benchmarks_week_idx ON benchmark_data(week_start DESC)`);

    // ---- ICP Similarity Matches ----
    // Pre-computed similarity matches for fast recommendation lookup.
    await client.query(`
      CREATE TABLE IF NOT EXISTS icp_similarity_recommendations (
        id SERIAL PRIMARY KEY,
        for_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        similar_icp_industry VARCHAR(100),
        similar_icp_size VARCHAR(100),
        recommended_angle VARCHAR(100),
        benchmark_reply_rate DECIMAL(5,4),
        sample_size INTEGER,
        confidence_level VARCHAR(20),
          -- high (n>100) | medium (n>30) | low (n>10)
        recommendation TEXT,
        computed_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS icp_recs_user_idx ON icp_similarity_recommendations(for_user_id, expires_at)`);

    console.log('[Migration] Intelligence network tables created');
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS icp_similarity_recommendations`);
    await client.query(`DROP TABLE IF EXISTS benchmark_data`);
    await client.query(`DROP TABLE IF EXISTS intelligence_signals`);
    await client.query(`DROP TABLE IF EXISTS intelligence_opt_ins`);
  }
};
