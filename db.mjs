// db.mjs
//
// Thin PostgreSQL dedup layer using node-postgres ("pg"). No ORM — a
// handful of parameterized queries is all this needs.
//
// SETUP:
//   npm install pg dotenv
//   Add to .env:
//     DATABASE_URL=postgres://user:password@localhost:5432/pfe_hunter

import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(
    import.meta.url));

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // SSL required for Supabase, Neon, and other cloud Postgres providers
    // rejectUnauthorized: false allows self-signed certificates (common in cloud providers)
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
});

// Database error handler
pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err);
    // Optionally: process.exit(-1) or implement reconnection logic
});

/**
 * Create the job_postings table if it doesn't exist yet. Safe to call on
 * every startup.
 */
export async function ensureSchema() {
    const schemaSql = await readFile(path.join(__dirname, 'schema.sql'), 'utf-8');
    await pool.query(schemaSql);
}

/**
 * Returns all postings that have NOT been scored yet (fit_score IS NULL).
 * This is what the pipeline queries after the Python scraper has inserted
 * new postings directly to Postgres.
 *
 * @returns {Promise<Array>} postings without fit_score
 */
export async function getUnscoredPostings() {
    const { rows } = await pool.query(`
        SELECT job_id, job_url, title, company, location, description
        FROM job_postings
        WHERE fit_score IS NULL
        ORDER BY created_at DESC
    `);
    return rows;
}

/**
 * Insert a batch of postings, skipping anything whose job_id OR job_url
 * already exists. Returns only the postings that were genuinely new, in
 * the same shape they came in — this is exactly the array you should hand
 * to the LLM agent downstream.
 *
 * NOTE: This function is now primarily used by the Node.js pipeline for
 * testing/manual inserts. The Python scraper inserts directly using the
 * same ON CONFLICT logic.
 *
 * @param {Array<{job_id: string, job_url: string, title: string, company?: string, location?: string, description?: string}>} postings
 * @returns {Promise<{inserted: Array, skipped: number}>}
 */
export async function dedupeAndInsert(postings) {
    if (postings.length === 0) {
        return { inserted: [], skipped: 0 };
    }

    const client = await pool.connect();
    const inserted = [];

    try {
        await client.query('BEGIN');

        for (const posting of postings) {
            const result = await client.query(
                `
                INSERT INTO job_postings (job_id, job_url, title, company, location, description)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (job_id) DO NOTHING
                RETURNING job_id, job_url, title, company, location, description
                `, [
                    posting.job_id,
                    posting.job_url,
                    posting.title,
                    posting.company ?? null,
                    posting.location ?? null,
                    posting.description ?? null,
                ]
            );

            if (result.rows.length > 0) {
                inserted.push(result.rows[0]);
            }
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    return {
        inserted,
        skipped: postings.length - inserted.length,
    };
}

/**
 * Bulk variant using a single multi-row INSERT. Faster for large batches.
 */
export async function dedupeAndInsertBulk(postings) {
    if (postings.length === 0) {
        return { inserted: [], skipped: 0 };
    }

    const columns = ['job_id', 'job_url', 'title', 'company', 'location', 'description'];
    const values = [];
    const placeholders = postings.map((p, i) => {
        const base = i * columns.length;
        values.push(p.job_id, p.job_url, p.title, p.company ?? null, p.location ?? null, p.description ?? null);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });

    const { rows } = await pool.query(
        `
        INSERT INTO job_postings (${columns.join(', ')})
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (job_id) DO NOTHING
        RETURNING job_id, job_url, title, company, location, description
        `,
        values
    );

    return {
        inserted: rows,
        skipped: postings.length - rows.length,
    };
}

/**
 * Writes fit_score + fit_reasoning back to existing rows after Gemini
 * scores them, and stamps scored_at.
 *
 * @param {Array<{job_id: string, fit_score: number, fit_reasoning: string}>} scoredPostings
 */
export async function saveScores(scoredPostings) {
    for (const p of scoredPostings) {
        await pool.query(
            `UPDATE job_postings
             SET fit_score = $2, fit_reasoning = $3, scored_at = now()
             WHERE job_id = $1`, [p.job_id, p.fit_score ?? null, p.fit_reasoning ?? null]
        );
    }
}

/**
 * Returns the subset of the given job_ids that have NOT been notified yet.
 *
 * @param {Array<string>} jobIds
 * @returns {Promise<Array<string>>}
 */
export async function filterUnnotified(jobIds) {
    if (jobIds.length === 0) return [];
    const { rows } = await pool.query(
        `SELECT job_id FROM job_postings WHERE job_id = ANY($1) AND notified_at IS NULL`, [jobIds]
    );
    return rows.map((r) => r.job_id);
}

/**
 * Stamps notified_at = now() on the given job_ids.
 *
 * @param {Array<string>} jobIds
 */
export async function markNotified(jobIds) {
    if (jobIds.length === 0) return;
    await pool.query(
        `UPDATE job_postings SET notified_at = now() WHERE job_id = ANY($1)`, [jobIds]
    );
}

export async function closePool() {
    await pool.end();
}

/**
 * Get a specific setting value from user_settings table.
 * Returns the raw string value, or default if not found.
 *
 * @param {string} key - Setting key
 * @param {string} defaultValue - Default value if not found
 * @returns {Promise<string>}
 */
export async function getSetting(key, defaultValue = null) {
    const { rows } = await pool.query(
        `SELECT setting_value FROM user_settings WHERE setting_key = $1`, [key]
    );
    return rows.length > 0 ? rows[0].setting_value : defaultValue;
}

/**
 * Get multiple settings at once.
 * Returns an object with setting_key -> setting_value.
 *
 * @param {Array<string>} keys - Array of setting keys
 * @returns {Promise<Object>}
 */
export async function getSettings(keys) {
    const { rows } = await pool.query(
        `SELECT setting_key, setting_value FROM user_settings WHERE setting_key = ANY($1)`, [keys]
    );
    const result = {};
    for (const row of rows) {
        result[row.setting_key] = row.setting_value;
    }
    return result;
}

/**
 * Set a setting value in user_settings table.
 *
 * @param {string} key - Setting key
 * @param {string} value - Setting value
 */
export async function setSetting(key, value) {
    await pool.query(
        `INSERT INTO user_settings (setting_key, setting_value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (setting_key)
         DO UPDATE SET setting_value = $2, updated_at = now()`, [key, value]
    );
}