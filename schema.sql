-- schema.sql
-- PostgreSQL schema for PFE Hunter.
--
-- This is the SINGLE SOURCE OF TRUTH for the schema — db.mjs's
-- ensureSchema() reads and executes this file directly.
--
-- Tables:
--   1. job_postings  - Scraped job listings with fit scores
--   2. user_settings - Dynamic configuration (scrape interval, thresholds, etc.)
--   3. cvs           - Uploaded CV files metadata

-- ============================================================
-- 1. JOB POSTINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS job_postings (
    id              SERIAL PRIMARY KEY,
    job_id          TEXT NOT NULL UNIQUE,
    job_url         TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    company         TEXT,
    location        TEXT,
    description     TEXT,
    source          TEXT DEFAULT 'linkedin',  --linkedin, indeed, jobteaser
    fit_score       INTEGER,
    fit_reasoning   TEXT,
    scored_at       TIMESTAMPTZ,
    notified_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for job_postings
CREATE INDEX IF NOT EXISTS idx_job_postings_job_id  ON job_postings (job_id);
CREATE INDEX IF NOT EXISTS idx_job_postings_job_url ON job_postings (job_url);
CREATE INDEX IF NOT EXISTS idx_job_postings_unnotified ON job_postings (job_id) WHERE notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_job_postings_source ON job_postings (source);
CREATE INDEX IF NOT EXISTS idx_job_postings_fit_score ON job_postings (fit_score);

-- ============================================================
-- 2. USER SETTINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS user_settings (
    id              SERIAL PRIMARY KEY,
    setting_key     TEXT NOT NULL UNIQUE,
    setting_value   TEXT NOT NULL,
    description     TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast key lookup
CREATE INDEX IF NOT EXISTS idx_user_settings_key ON user_settings (setting_key);

-- Default settings
INSERT INTO user_settings (setting_key, setting_value, description) VALUES
    -- Scrape configuration
    ('scrape_interval_minutes', '300', 'DEPRECATED (unused): the schedule is controlled solely by the GitHub Actions cron (0 */5 * * * = every 5 hours)'),
    ('results_wanted', '10', 'Number of job postings to fetch per source. Max: 50'),
    ('hours_old', '336', 'Only fetch jobs posted within this many hours'),

    -- Search configuration (JSON arrays)
    ('search_terms', '["software engineering internship"]', 'Keywords to search for. JSON array of strings.'),
    ('locations', '["France"]', 'Locations to search in. JSON array of strings.'),
    ('job_sites', '["linkedin", "indeed", "jobteaser"]', 'Job sites to scrape. JSON array: linkedin, indeed, jobteaser'),
    ('title_keywords', '["software", "developer", "backend", "frontend", "fullstack", "full-stack", "engineer", "data", "ai", "machine learning", "intern", "stage"]', 'Filter jobs by these title keywords. JSON array.'),

    -- Scoring configuration
    ('fit_score_threshold', '70', 'Minimum fit score to trigger Discord notification (0-100)'),

    -- Rate limiting info (read-only, for display)
    ('gemini_rpd_limit', '1000', 'Gemini API requests per day limit (free tier: 100-1000)')
ON CONFLICT (setting_key) DO NOTHING;

-- ============================================================
-- 3. CVs (Curriculum Vitae uploads)
-- ============================================================

CREATE TABLE IF NOT EXISTS cvs (
    id              SERIAL PRIMARY KEY,
    filename        TEXT NOT NULL,
    original_name   TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    file_size       INTEGER,
    mime_type       TEXT DEFAULT 'application/pdf',
    is_active       BOOLEAN DEFAULT true,
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one active CV at a time
CREATE INDEX IF NOT EXISTS idx_cvs_active ON cvs (id) WHERE is_active = true;

-- ============================================================
-- 4. PIPELINE RUNS (for dashboard activity timeline)
-- ============================================================

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id              SERIAL PRIMARY KEY,
    status          TEXT NOT NULL DEFAULT 'running',  -- running, success, failed
    step            TEXT,                             -- Current step (scraper, scoring, mcp-notify)
    postings_found  INTEGER DEFAULT 0,
    postings_inserted INTEGER DEFAULT 0,
    postings_scored INTEGER DEFAULT 0,
    error_message   TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    elapsed_seconds REAL
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs (started_at DESC);

-- ============================================================
-- 5. HELPER FUNCTIONS
-- ============================================================

-- Function to get a setting value easily
CREATE OR REPLACE FUNCTION get_setting(key TEXT)
RETURNS TEXT AS $$
BEGIN
    RETURN (SELECT setting_value FROM user_settings WHERE setting_key = key);
END;
$$ LANGUAGE plpgsql;

-- Function to set a setting value
CREATE OR REPLACE FUNCTION set_setting(key TEXT, value TEXT)
RETURNS VOID AS $$
BEGIN
    INSERT INTO user_settings (setting_key, setting_value, updated_at)
    VALUES (key, value, now())
    ON CONFLICT (setting_key)
    DO UPDATE SET setting_value = value, updated_at = now();
END;
$$ LANGUAGE plpgsql;
