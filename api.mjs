// api.mjs
//
// Backend API for PFE Hunter Dashboard.
// Express server that connects to Postgres and serves data to the React frontend.
//
// SECURITY: every endpoint except GET /api/health requires the API_TOKEN —
// sent as "Authorization: Bearer <token>" or "?token=<token>". General
// endpoints are rate limited to 100 req/15min/IP; POST /api/pipeline/trigger
// to 10 req/15min/IP.
//
// ENDPOINTS:
//   GET  /api/health         - Health check (public, no token)
//   GET  /api/postings       - List all postings (with filters)
//   GET  /api/postings/:id   - Get single posting
//   GET  /api/stats          - Get aggregated statistics
//   GET  /api/runs           - Get recent run history
//   POST /api/cv/upload      - Upload CV file (→ Supabase Storage)
//   GET  /api/cv             - Get current CV info
//   GET  /api/cv/download    - Download current CV
//   DELETE /api/cv           - Delete CV
//
// SETUP:
//   npm install express cors pg dotenv multer @supabase/supabase-js
//   node api.mjs

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import crypto from 'node:crypto';
import { z } from 'zod';
import Filter from 'xss';
import { pool, ensureSchema } from './db.mjs';
import {
    isSupabaseConfigured,
    ensureCvBucket,
    uploadCvToStorage,
    deleteCvFile,
    downloadCvFromStorage,
} from './supabase-storage.mjs';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = process.env.API_PORT || 3001;
const API_TOKEN = process.env.API_TOKEN;
const __dirname = path.dirname(fileURLToPath(
    import.meta.url));

// Track pipeline run status in memory
let currentPipelineRun = null;

// Security middleware
app.use(helmet());

// ---------- RATE LIMITING ----------
// General limiter: 100 requests / 15 min / IP for the whole API.
// /api/health is excluded so uptime monitors never trip the limit.
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/api/health',
});
app.use(generalLimiter);

// Strict limiter for the manual pipeline trigger: 10 requests / 15 min / IP.
// Spawning the scraper + Gemini scoring is expensive — this endpoint is the
// obvious abuse target.
const pipelineLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many pipeline run requests. You can trigger at most 10 runs per 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Trust proxy for rate limiting behind PaaS (Render, Cloudflare, etc.)
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// CORS configuration
// Allow both the main domain and Cloudflare Pages preview URLs
const allowedOrigins = [
    'http://localhost:5173',
    'https://pfe-hunter.pages.dev',
];

// In production, also allow any *.pages.dev preview URLs
const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);

        // Check if origin matches allowed list or is a pages.dev preview URL
        if (allowedOrigins.includes(origin) ||
            origin.endsWith('.pfe-hunter.pages.dev') ||
            origin.includes('.pages.dev')) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
};

app.use(cors(corsOptions));

// Request logging
// Keep the console readable: the dashboard polls /api/pipeline/status every
// ~2s, which would spam one long line per request. Skip successful GETs
// (incl. 304 Not Modified); still log every error (4xx/5xx) and every
// non-GET request (pipeline start, CV upload/delete, ...).
// Set ACCESS_LOG=all in .env to restore full request logging if ever needed.
const accessLogMode = (process.env.ACCESS_LOG || 'compact').toLowerCase();
if (accessLogMode !== 'off') {
    app.use(morgan('combined', {
        skip: accessLogMode === 'all'
            ? () => false // log everything
            : (req, res) => req.method === 'GET' && res.statusCode < 400,
    }));
}

app.use(express.json());

// ---------- AUTHENTICATION ----------
// Token-based auth protecting every /api route except /api/health.
// The token is read from either:
//   - the "Authorization: Bearer <token>" header (used by the dashboard), or
//   - the "?token=<token>" query parameter (handy for curl / monitoring).
// Comparison is timing-safe to prevent leaking the token byte-by-byte.
function safeTokenCompare(provided, expected) {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) {
        // Burn the same amount of time as a successful compare, then fail.
        crypto.timingSafeEqual(b, b);
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

function extractRequestToken(req) {
    const header = req.headers.authorization || '';
    const headerToken = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
    const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : null;
    return headerToken || queryToken || null;
}

function authMiddleware(req, res, next) {
    // Fail closed: without API_TOKEN the API is unusable rather than open.
    if (!API_TOKEN) {
        console.error('[Auth] REJECTED — API_TOKEN is not set in the environment. Refusing all requests.');
        return res.status(500).json({
            error: 'Server authentication is not configured. Set API_TOKEN in the environment and restart.'
        });
    }

    const token = extractRequestToken(req);
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';

    if (!token) {
        console.warn(`[Auth] DENIED (no token) ${req.method} ${req.originalUrl} from ${clientIp}`);
        return res.status(401).json({
            error: 'Unauthorized. Provide the API token via the "Authorization: Bearer <token>" header or a ?token= query parameter.'
        });
    }

    if (!safeTokenCompare(token, API_TOKEN)) {
        console.warn(`[Auth] DENIED (invalid token: ${token.slice(0, 4)}***) ${req.method} ${req.originalUrl} from ${clientIp}`);
        return res.status(401).json({ error: 'Unauthorized. Invalid API token.' });
    }

    console.log(`[Auth] OK ${req.method} ${req.originalUrl} from ${clientIp}`);
    next();
}

// Health check stays public (uptime monitors, Render health checks).
// It is registered BEFORE the auth middleware below, so it needs no token.
app.get('/api/health', async(req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected' });
    } catch (err) {
        res.status(503).json({ status: 'error', database: 'disconnected', error: err.message });
    }
});

// Everything below this line requires a valid token.
app.use(authMiddleware);

// ---------- INPUT VALIDATION HELPERS ----------
// XSS-neutralizing sanitizer for string inputs (query params, setting values).
const sanitize = (value) => (typeof value === 'string' ? Filter(value) : value);

/**
 * Returns req.query without the auth `token` param, so ?token= requests
 * aren't rejected by strict query validation.
 */
function sanitizedQuery(req) {
    const { token, ...rest } = req.query;
    return rest;
}

/** Recursively sanitizes every string inside a parsed JSON value. */
function sanitizeDeep(value) {
    if (typeof value === 'string') return Filter(value);
    if (Array.isArray(value)) return value.map(sanitizeDeep);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v)]));
    }
    return value;
}

/**
 * Validates data against a zod schema and responds 400 with clear messages
 * on failure. Returns the parsed (and coerced) data, or null if invalid.
 */
function validate(schema, data, res, label) {
    const result = schema.safeParse(data);
    if (!result.success) {
        const details = result.error.issues.map((i) => `${i.path.join('.') || label}: ${i.message}`);
        res.status(400).json({ error: `Invalid ${label}`, details });
        return null;
    }
    return result.data;
}

/** Distinguishes user-input errors (400) from server faults (500). */
class ValidationError extends Error {}

const postingsQuerySchema = z.object({
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    maxScore: z.coerce.number().int().min(0).max(100).optional(),
    company: z.string().trim().max(200).optional(),
    location: z.string().trim().max(200).optional(),
    notified: z.enum(['all', 'notified', 'not-notified']).optional(),
    sort: z.enum(['fit_score', 'created_at', 'company', 'title']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
}).strict();

const limitQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

const jobIdParamSchema = z.object({
    id: z.string().trim().min(1).max(200),
}).strict();

// Setting keys that may be written. scrape_interval_minutes was removed —
// the schedule is controlled solely by the GitHub Actions cron.
const SETTING_KEYS = [
    'results_wanted',
    'hours_old',
    'search_terms',
    'locations',
    'job_sites',
    'title_keywords',
    'fit_score_threshold',
];

const settingKeyParamSchema = z.object({
    key: z.enum(SETTING_KEYS),
}).strict();

const bulkSettingsBodySchema = z.object({
    settings: z.record(z.string().max(100), z.string().max(5000)),
}).strict();

const singleSettingBodySchema = z.object({
    value: z.string().max(5000),
}).strict();

// ---------- CV UPLOAD (Supabase Storage) ----------
// Sanitize filename to prevent path traversal and odd characters.
const sanitizeFilename = (filename) => {
    return path.basename(filename).replace(/[^a-zA-Z0-9.-]/g, '_');
};

// Configure multer for CV uploads.
// Files are held IN MEMORY (never written to disk) and pushed straight to
// Supabase Storage — Render's disk is ephemeral, so local copies would be
// lost on redeploy anyway.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        files: 1,
    },
    fileFilter: (req, file, cb) => {
        // 1) Only PDF is accepted.
        if (file.mimetype !== 'application/pdf' || path.extname(file.originalname).toLowerCase() !== '.pdf') {
            return cb(new Error('Invalid file type. Only PDF files are allowed.'));
        }

        // 2) File name sanity: no special characters, reasonable length.
        const baseName = path.basename(file.originalname);
        const MAX_FILENAME_LENGTH = 255;
        if (!baseName || baseName.length > MAX_FILENAME_LENGTH) {
            return cb(new Error(`File name is empty or longer than ${MAX_FILENAME_LENGTH} characters.`));
        }
        if (!/^[a-zA-Z0-9._\- ]+$/.test(baseName)) {
            return cb(new Error('File name contains invalid characters. Use letters, numbers, spaces, dots, dashes or underscores.'));
        }

        cb(null, true);
    }
});

// ---------- HELPERS ----------

function formatDate(date) {
    if (!date) return null;
    return date.toISOString();
}

function formatPosting(row) {
    return {
        job_id: row.job_id,
        job_url: row.job_url,
        title: row.title,
        company: row.company,
        location: row.location,
        description: row.description,
        fit_score: row.fit_score,
        fit_reasoning: row.fit_reasoning,
        created_at: formatDate(row.created_at),
        scored_at: formatDate(row.scored_at),
        notified_at: formatDate(row.notified_at),
    };
}

// ---------- ROUTES ----------

// Get all postings with filters
app.get('/api/postings', async(req, res) => {
    try {
        // Validate + coerce every query parameter (zod, strict — unknown
        // params are rejected). Strings are XSS-sanitized before use.
        const query = validate(postingsQuerySchema, sanitizedQuery(req), res, 'query parameters');
        if (query === null) return;

        const { minScore, maxScore, company, location, notified, sort, order, limit, offset } = query;

        let sql = 'SELECT * FROM job_postings WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        // Fit score filter (already validated 0-100 by zod)
        if (minScore !== undefined) {
            sql += ` AND fit_score >= $${paramIndex++}`;
            params.push(minScore);
        }
        if (maxScore !== undefined) {
            sql += ` AND fit_score <= $${paramIndex++}`;
            params.push(maxScore);
        }

        // Company filter (case-insensitive partial match, sanitized)
        if (company) {
            sql += ` AND company ILIKE $${paramIndex++}`;
            params.push(`%${sanitize(company)}%`);
        }

        // Location filter (case-insensitive partial match, sanitized)
        if (location) {
            sql += ` AND location ILIKE $${paramIndex++}`;
            params.push(`%${sanitize(location)}%`);
        }

        // Notification status filter
        if (notified === 'notified') {
            sql += ' AND notified_at IS NOT NULL';
        } else if (notified === 'not-notified') {
            sql += ' AND notified_at IS NULL';
        }

        // Sorting — strict whitelist via zod enum above; safe to interpolate.
        const ALLOWED_SORTS = {
            'fit_score': 'fit_score',
            'created_at': 'created_at',
            'company': 'company',
            'title': 'title'
        };
        const sortField = ALLOWED_SORTS[sort] || 'created_at';
        const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
        sql += ` ORDER BY ${sortField} ${sortOrder}`;

        // Pagination (validated + clamped by zod: limit 1-100, offset >= 0)
        const limitVal = limit ?? 100;
        const offsetVal = offset ?? 0;
        sql += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        params.push(limitVal, offsetVal);

        const { rows } = await pool.query(sql, params);
        res.json(rows.map(formatPosting));
    } catch (err) {
        console.error('Error fetching postings:', err);
        res.status(500).json({ error: 'Failed to fetch postings' });
    }
});

// Get single posting by job_id
app.get('/api/postings/:id', async(req, res) => {
    try {
        const params = validate(jobIdParamSchema, req.params, res, 'path parameters');
        if (params === null) return;

        const { rows } = await pool.query(
            'SELECT * FROM job_postings WHERE job_id = $1', [sanitize(params.id)]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Posting not found' });
        }

        res.json(formatPosting(rows[0]));
    } catch (err) {
        console.error('Error fetching posting:', err);
        res.status(500).json({ error: 'Failed to fetch posting' });
    }
});

// Get aggregated statistics
app.get('/api/stats', async(req, res) => {
    try {
        // Total postings
        const totalResult = await pool.query('SELECT COUNT(*) FROM job_postings');
        const total = parseInt(totalResult.rows[0].count);

        // Average fit score
        const avgResult = await pool.query(
            'SELECT AVG(fit_score) as avg FROM job_postings WHERE fit_score IS NOT NULL'
        );
        const averageScore = Math.round(parseFloat(avgResult.rows[0].avg) || 0);

        // High-fit matches (>= 70)
        const highFitResult = await pool.query(
            'SELECT COUNT(*) FROM job_postings WHERE fit_score >= 70'
        );
        const highFit = parseInt(highFitResult.rows[0].count);

        // Notified count
        const notifiedResult = await pool.query(
            'SELECT COUNT(*) FROM job_postings WHERE notified_at IS NOT NULL'
        );
        const notified = parseInt(notifiedResult.rows[0].count);

        // Unscored count
        const unscoredResult = await pool.query(
            'SELECT COUNT(*) FROM job_postings WHERE fit_score IS NULL'
        );
        const unscored = parseInt(unscoredResult.rows[0].count);

        res.json({
            total,
            averageScore,
            highFit,
            notified,
            unscored,
        });
    } catch (err) {
        console.error('Error fetching stats:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Get score distribution for charts
app.get('/api/distribution', async(req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT
                CASE
                    WHEN fit_score <= 20 THEN '0-20'
                    WHEN fit_score <= 40 THEN '21-40'
                    WHEN fit_score <= 60 THEN '41-60'
                    WHEN fit_score <= 80 THEN '61-80'
                    ELSE '81-100'
                END as range,
                COUNT(*) as count
            FROM job_postings
            WHERE fit_score IS NOT NULL
            GROUP BY range
            ORDER BY range
        `);

        // Ensure all ranges are present
        const distribution = {
            '0-20': 0,
            '21-40': 0,
            '41-60': 0,
            '61-80': 0,
            '81-100': 0,
        };

        rows.forEach(row => {
            distribution[row.range] = parseInt(row.count);
        });

        res.json(distribution);
    } catch (err) {
        console.error('Error fetching distribution:', err);
        res.status(500).json({ error: 'Failed to fetch distribution' });
    }
});

// Get recent run history (reads from database, not local file)
app.get('/api/runs', async(req, res) => {
    try {
        const query = validate(limitQuerySchema, sanitizedQuery(req), res, 'query parameters');
        if (query === null) return;

        const limitVal = query.limit ?? 10;

        const { rows } = await pool.query(
            `SELECT id, status, step, postings_found, postings_inserted, postings_scored,
                    error_message, started_at, finished_at, elapsed_seconds
             FROM pipeline_runs
             ORDER BY started_at DESC
             LIMIT $1`, [limitVal]
        );

        // Transform to match the format expected by ActivityTimeline component
        res.json(rows.map(row => ({
            id: row.id,
            status: row.status,
            step: row.step,
            inserted: row.postings_inserted || 0,
            scored: row.postings_scored || 0,
            timestamp: row.started_at,
            elapsed_seconds: row.elapsed_seconds,
            error_message: row.error_message
        })));
    } catch (err) {
        console.error('Error fetching runs:', err);
        res.status(500).json({ error: 'Failed to fetch runs' });
    }
});

// Get unique companies for filter dropdown
app.get('/api/companies', async(req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT DISTINCT company FROM job_postings WHERE company IS NOT NULL ORDER BY company'
        );
        res.json(rows.map(r => r.company));
    } catch (err) {
        console.error('Error fetching companies:', err);
        res.status(500).json({ error: 'Failed to fetch companies' });
    }
});

// Get unique locations for filter dropdown
app.get('/api/locations', async(req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT DISTINCT location FROM job_postings WHERE location IS NOT NULL ORDER BY location'
        );
        res.json(rows.map(r => r.location));
    } catch (err) {
        console.error('Error fetching locations:', err);
        res.status(500).json({ error: 'Failed to fetch locations' });
    }
});

// ---------- SETTINGS ROUTES ----------

// Get all settings
app.get('/api/settings', async(req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT setting_key, setting_value, description, updated_at FROM user_settings ORDER BY setting_key'
        );

        // Convert to object format for easier frontend use
        const settings = {};
        rows.forEach(row => {
            settings[row.setting_key] = {
                value: row.setting_value,
                description: row.description,
                updated_at: formatDate(row.updated_at),
            };
        });

        res.json(settings);
    } catch (err) {
        console.error('Error fetching settings:', err);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Get single setting
app.get('/api/settings/:key', async(req, res) => {
    try {
        const { key } = req.params;
        const { rows } = await pool.query(
            'SELECT setting_key, setting_value, description, updated_at FROM user_settings WHERE setting_key = $1', [key]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Setting not found' });
        }

        res.json({
            key: rows[0].setting_key,
            value: rows[0].setting_value,
            description: rows[0].description,
            updated_at: formatDate(rows[0].updated_at),
        });
    } catch (err) {
        console.error('Error fetching setting:', err);
        res.status(500).json({ error: 'Failed to fetch setting' });
    }
});

// Update single setting (requires authentication)
app.put('/api/settings/:key', authMiddleware, async(req, res) => {
    try {
        const params = validate(settingKeyParamSchema, req.params, res, 'path parameters');
        if (params === null) return;

        const body = validate(singleSettingBodySchema, req.body, res, 'request body');
        if (body === null) return;

        const { key } = params;
        const value = sanitize(body.value);

        // Validate value based on key
        const validationError = validateSetting(key, value);
        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        const { rows } = await pool.query(
            `UPDATE user_settings
             SET setting_value = $1, updated_at = now()
             WHERE setting_key = $2
             RETURNING setting_key, setting_value, description, updated_at`, [value, key]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Setting not found' });
        }

        res.json({
            key: rows[0].setting_key,
            value: rows[0].setting_value,
            description: rows[0].description,
            updated_at: formatDate(rows[0].updated_at),
        });
    } catch (err) {
        console.error('Error updating setting:', err);
        res.status(500).json({ error: 'Failed to update setting' });
    }
});

// Update multiple settings at once (requires authentication)
app.put('/api/settings', authMiddleware, async(req, res) => {
    try {
        const body = validate(bulkSettingsBodySchema, req.body, res, 'request body');
        if (body === null) return;

        const settings = body.settings;

        // Reject unknown/deprecated keys up front — silently ignoring them
        // would make the dashboard believe a setting was saved when it wasn't.
        const unknownKeys = Object.keys(settings).filter(k => !SETTING_KEYS.includes(k));
        if (unknownKeys.length > 0) {
            return res.status(400).json({ error: `Invalid setting key(s): ${unknownKeys.join(', ')}` });
        }

        const client = await pool.connect();
        const updated = [];

        try {
            await client.query('BEGIN');

            for (const [key, rawValue] of Object.entries(settings)) {
                // Sanitize + validate (JSON arrays get each element sanitized)
                const value = sanitizeDeep(rawValue);
                const validationError = validateSetting(key, value);
                if (validationError) {
                    throw new ValidationError(`Invalid setting ${key}: ${validationError}`);
                }

                const result = await client.query(
                    `UPDATE user_settings
                     SET setting_value = $1, updated_at = now()
                     WHERE setting_key = $2
                     RETURNING setting_key, setting_value`, [value, key]
                );

                if (result.rows.length > 0) {
                    updated.push({
                        key: result.rows[0].setting_key,
                        value: result.rows[0].setting_value,
                    });
                }
            }

            await client.query('COMMIT');
            res.json({ updated, count: updated.length });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error updating settings:', err);
        if (err instanceof ValidationError) {
            return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: err.message || 'Failed to update settings' });
    }
});

// Reset settings to defaults (requires authentication)
app.post('/api/settings/reset', authMiddleware, async(req, res) => {
    try {
        const defaults = {
            results_wanted: '10',
            hours_old: '336',
            search_terms: '["software engineering internship"]',
            locations: '["France"]',
            job_sites: '["linkedin", "indeed", "jobteaser"]',
            title_keywords: '["software", "developer", "backend", "frontend", "fullstack", "full-stack", "engineer", "data", "ai", "machine learning", "intern", "stage"]',
            fit_score_threshold: '70',
        };

        const client = await pool.connect();
        let resetCount = 0;

        try {
            await client.query('BEGIN');

            for (const [key, value] of Object.entries(defaults)) {
                const result = await client.query(
                    `UPDATE user_settings
                     SET setting_value = $1, updated_at = now()
                     WHERE setting_key = $2`, [value, key]
                );
                if (result.rowCount > 0) resetCount++;
            }

            await client.query('COMMIT');
            res.json({ message: 'Settings reset to defaults', count: resetCount });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error resetting settings:', err);
        res.status(500).json({ error: 'Failed to reset settings' });
    }
});

// ---------- VALIDATION ----------

function validateSetting(key, value) {
    switch (key) {
        // NOTE: scrape_interval_minutes was removed — the pipeline schedule
        // is controlled solely by the GitHub Actions cron (0 */5 * * *).

        case 'results_wanted':
            const results = parseInt(value);
            if (isNaN(results) || results < 1 || results > 50) {
                return 'results_wanted must be between 1 and 50';
            }
            break;

        case 'hours_old':
            const hours = parseInt(value);
            if (isNaN(hours) || hours < 1 || hours > 336) {
                return 'hours_old must be between 1 and 336 (14 days)';
            }
            break;

        case 'fit_score_threshold':
            const threshold = parseInt(value);
            if (isNaN(threshold) || threshold < 0 || threshold > 100) {
                return 'fit_score_threshold must be between 0 and 100';
            }
            break;

        case 'search_terms':
        case 'locations':
        case 'job_sites':
        case 'title_keywords':
            try {
                const arr = JSON.parse(value);
                if (!Array.isArray(arr)) {
                    return `${key} must be a JSON array`;
                }
                if (key === 'job_sites') {
                    const validSites = ['linkedin', 'indeed', 'jobteaser'];
                    const invalid = arr.filter(s => !validSites.includes(s));
                    if (invalid.length > 0) {
                        return `Invalid job sites: ${invalid.join(', ')}. Valid: ${validSites.join(', ')}`;
                    }
                }
            } catch (e) {
                return `${key} must be valid JSON`;
            }
            break;
    }
    return null;
}

// ---------- CV MANAGEMENT ROUTES ----------

// Upload CV file (requires authentication).
// The file is stored in the Supabase Storage "cvs" bucket and its public URL
// is saved in cvs.file_path — survives redeploys, unlike the old local-disk
// approach on Render's ephemeral filesystem.
app.post('/api/cv/upload', authMiddleware, upload.single('cv'), async(req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded. Attach a PDF in a multipart/form-data "cv" field.' });
        }

        if (!isSupabaseConfigured()) {
            return res.status(503).json({
                error: 'CV storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment, then restart the API.'
            });
        }

        // Unique, sanitized object name inside the bucket.
        const storedName = `cv-${Date.now()}-${Math.round(Math.random() * 1E9)}.pdf`;
        const publicUrl = await uploadCvToStorage(req.file.buffer, storedName, req.file.mimetype);

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Deactivate any existing active CVs
            await client.query('UPDATE cvs SET is_active = false WHERE is_active = true');

            // Insert new CV record (file_path now points at Supabase Storage)
            const { rows } = await client.query(
                `INSERT INTO cvs (filename, original_name, file_path, file_size, mime_type, is_active)
                 VALUES ($1, $2, $3, $4, $5, true)
                 RETURNING id, filename, original_name, file_size, mime_type, uploaded_at`, [
                    storedName,
                    sanitizeFilename(req.file.originalname),
                    publicUrl,
                    req.file.size,
                    req.file.mimetype
                ]
            );

            await client.query('COMMIT');

            res.json({
                message: 'CV uploaded successfully',
                cv: {
                    id: rows[0].id,
                    filename: rows[0].filename,
                    original_name: rows[0].original_name,
                    file_size: rows[0].file_size,
                    mime_type: rows[0].mime_type,
                    uploaded_at: formatDate(rows[0].uploaded_at)
                }
            });
        } catch (err) {
            await client.query('ROLLBACK');
            // Orphaned object in Storage if the DB insert failed — clean it up.
            await deleteCvFile(publicUrl).catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error uploading CV:', err);
        res.status(500).json({ error: err.message || 'Failed to upload CV' });
    }
});

// Get current CV info
app.get('/api/cv', async(req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, filename, original_name, file_size, mime_type, uploaded_at
             FROM cvs
             WHERE is_active = true
             ORDER BY uploaded_at DESC
             LIMIT 1`
        );

        if (rows.length === 0) {
            return res.json({ cv: null });
        }

        res.json({
            cv: {
                id: rows[0].id,
                filename: rows[0].filename,
                original_name: rows[0].original_name,
                file_size: rows[0].file_size,
                mime_type: rows[0].mime_type,
                uploaded_at: formatDate(rows[0].uploaded_at)
            }
        });
    } catch (err) {
        console.error('Error fetching CV:', err);
        res.status(500).json({ error: 'Failed to fetch CV' });
    }
});

// Download CV file
app.get('/api/cv/download', async(req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT filename, original_name, file_path, mime_type
             FROM cvs
             WHERE is_active = true
             ORDER BY uploaded_at DESC
             LIMIT 1`
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'No CV found' });
        }

        const cv = rows[0];

        // Sanitize filename for Content-Disposition header
        const sanitizedFilename = cv.original_name.replace(/["\r\n]/g, '');
        res.setHeader('Content-Type', cv.mime_type || 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);

        // New storage model: file_path is a Supabase public URL.
        if (/^https?:\/\//i.test(cv.file_path)) {
            try {
                const buffer = await downloadCvFromStorage(cv.file_path);
                return res.send(buffer);
            } catch (err) {
                console.error('Error downloading CV from Supabase:', err);
                return res.status(404).json({ error: 'CV file could not be fetched from Supabase Storage' });
            }
        }

        // Legacy fallback: pre-migration rows may still hold a local path.
        if (!existsSync(cv.file_path)) {
            return res.status(404).json({ error: 'CV file not found on disk' });
        }

        const fileContent = await readFile(cv.file_path);
        res.send(fileContent);
    } catch (err) {
        console.error('Error downloading CV:', err);
        res.status(500).json({ error: 'Failed to download CV' });
    }
});

// Delete CV (requires authentication)
app.delete('/api/cv', authMiddleware, async(req, res) => {
    try {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Get active CV
            const { rows } = await client.query(
                `SELECT id, file_path FROM cvs WHERE is_active = true LIMIT 1`
            );

            if (rows.length === 0) {
                await client.query('ROLLBACK');
                return res.json({ message: 'No active CV to delete' });
            }

            const cv = rows[0];

            // Delete from database
            await client.query('DELETE FROM cvs WHERE id = $1', [cv.id]);

            await client.query('COMMIT');

            // Delete the file: Supabase Storage for URL rows, disk for legacy
            // path rows. Best-effort — the DB record is already gone.
            try {
                await deleteCvFile(cv.file_path);
            } catch (storageErr) {
                console.warn('Failed to delete CV file from storage:', storageErr.message);
            }

            res.json({ message: 'CV deleted successfully' });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error deleting CV:', err);
        res.status(500).json({ error: 'Failed to delete CV' });
    }
});

// Error handler for multer
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
        }
        return res.status(400).json({ error: error.message });
    } else if (error) {
        return res.status(400).json({ error: error.message });
    }
    next();
});

// ---------- PIPELINE MANAGEMENT ROUTES ----------

// Trigger immediate pipeline run (requires authentication).
// Strictly rate limited — spawning the scraper + Gemini scoring is expensive.
app.post('/api/pipeline/trigger', pipelineLimiter, authMiddleware, async(req, res) => {
    try {
        // Check if a run is already in progress
        if (currentPipelineRun && currentPipelineRun.status === 'running') {
            return res.status(409).json({
                error: 'A pipeline run is already in progress',
                run: currentPipelineRun
            });
        }

        // Create new run record
        const { rows } = await pool.query(
            `INSERT INTO pipeline_runs (status, step, started_at)
             VALUES ('running', 'initializing', now())
             RETURNING id, status, step, started_at`
        );

        const runId = rows[0].id;

        // Initialize run tracking
        currentPipelineRun = {
            id: runId,
            status: 'running',
            step: 'initializing',
            postings_found: 0,
            postings_inserted: 0,
            postings_scored: 0,
            started_at: formatDate(rows[0].started_at)
        };

        res.json({
            message: 'Pipeline run triggered',
            run: currentPipelineRun
        });

        // Execute pipeline asynchronously
        executePipeline(runId).catch(err => {
            console.error('Pipeline execution error:', err);
        });

    } catch (err) {
        console.error('Error triggering pipeline:', err);
        res.status(500).json({ error: 'Failed to trigger pipeline' });
    }
});

// Get current pipeline run status
app.get('/api/pipeline/status', async(req, res) => {
    try {
        if (currentPipelineRun) {
            // Get latest data from database
            const { rows } = await pool.query(
                `SELECT id, status, step, postings_found, postings_inserted, postings_scored,
                        error_message, started_at, finished_at, elapsed_seconds
                 FROM pipeline_runs
                 WHERE id = $1`, [currentPipelineRun.id]
            );

            if (rows.length > 0) {
                currentPipelineRun = {
                    id: rows[0].id,
                    status: rows[0].status,
                    step: rows[0].step,
                    postings_found: rows[0].postings_found,
                    postings_inserted: rows[0].postings_inserted,
                    postings_scored: rows[0].postings_scored,
                    error_message: rows[0].error_message,
                    started_at: formatDate(rows[0].started_at),
                    finished_at: formatDate(rows[0].finished_at),
                    elapsed_seconds: rows[0].elapsed_seconds
                };
            }

            return res.json({ run: currentPipelineRun });
        }

        // No current run, check for most recent run
        const { rows } = await pool.query(
            `SELECT id, status, step, postings_found, postings_inserted, postings_scored,
                    error_message, started_at, finished_at, elapsed_seconds
             FROM pipeline_runs
             ORDER BY started_at DESC
             LIMIT 1`
        );

        if (rows.length > 0) {
            return res.json({
                run: {
                    id: rows[0].id,
                    status: rows[0].status,
                    step: rows[0].step,
                    postings_found: rows[0].postings_found,
                    postings_inserted: rows[0].postings_inserted,
                    postings_scored: rows[0].postings_scored,
                    error_message: rows[0].error_message,
                    started_at: formatDate(rows[0].started_at),
                    finished_at: formatDate(rows[0].finished_at),
                    elapsed_seconds: rows[0].elapsed_seconds
                }
            });
        }

        res.json({ run: null });

    } catch (err) {
        console.error('Error fetching pipeline status:', err);
        res.status(500).json({ error: 'Failed to fetch pipeline status' });
    }
});

// Get pipeline run history
app.get('/api/pipeline/runs', async(req, res) => {
    try {
        const query = validate(limitQuerySchema, sanitizedQuery(req), res, 'query parameters');
        if (query === null) return;

        const limitVal = query.limit ?? 20;

        const { rows } = await pool.query(
            `SELECT id, status, step, postings_found, postings_inserted, postings_scored,
                    error_message, started_at, finished_at, elapsed_seconds
             FROM pipeline_runs
             ORDER BY started_at DESC
             LIMIT $1`, [limitVal]
        );

        res.json({
            runs: rows.map(row => ({
                id: row.id,
                status: row.status,
                step: row.step,
                postings_found: row.postings_found,
                postings_inserted: row.postings_inserted,
                postings_scored: row.postings_scored,
                error_message: row.error_message,
                started_at: formatDate(row.started_at),
                finished_at: formatDate(row.finished_at),
                elapsed_seconds: row.elapsed_seconds
            }))
        });

    } catch (err) {
        console.error('Error fetching pipeline runs:', err);
        res.status(500).json({ error: 'Failed to fetch pipeline runs' });
    }
});

// Execute pipeline (async background task)
async function executePipeline(runId) {
    const { spawn } = await
    import ('node:child_process');

    try {
        // Resolve the CV BEFORE scraping — no point scraping job postings if
        // we have no CV to score them against. The dashboard uploads CVs to
        // Supabase Storage and records the public URL in the `cvs` table.
        // The child process receives that URL via CV_SUPABASE_URL and
        // downloads the file itself (gemini-scoring.mjs). Legacy rows that
        // still hold a local path keep working via CV_FILE_PATH.
        const { rows: cvRows } = await pool.query(
            `SELECT file_path
             FROM cvs
             WHERE is_active = true
             ORDER BY uploaded_at DESC
             LIMIT 1`
        );

        if (cvRows.length === 0) {
            throw new Error('No CV uploaded yet. Upload a CV on the Settings page, then run the pipeline again.');
        }

        const cvFileRef = cvRows[0].file_path;
        const isStorageUrl = /^https?:\/\//i.test(cvFileRef);

        // Legacy local path — verify it still exists (ephemeral filesystems).
        let cvEnv = {};
        if (!isStorageUrl) {
            const cvFilePath = path.resolve(cvFileRef);
            if (!existsSync(cvFilePath)) {
                throw new Error(`CV file missing on disk: ${cvFilePath}. The service filesystem is ephemeral on Render — re-upload your CV after every deploy/restart.`);
            }
            cvEnv = { CV_FILE_PATH: cvFilePath };
        } else {
            cvEnv = { CV_SUPABASE_URL: cvFileRef };
        }

        // Update step: scraping
        await updatePipelineRun(runId, 'running', 'scraper');

        // Run Python scraper
        const scraperProcess = spawn('python', ['scrape_jobspy.py'], {
            cwd: __dirname,
            stdio: 'pipe'
        });

        let scraperOutput = '';
        let scraperError = '';

        scraperProcess.stdout.on('data', (data) => {
            scraperOutput += data.toString();
            console.log('[Scraper]', data.toString());
        });

        scraperProcess.stderr.on('data', (data) => {
            scraperError += data.toString();
            console.error('[Scraper Error]', data.toString());
        });

        await new Promise((resolve, reject) => {
            scraperProcess.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Scraper exited with code ${code}: ${scraperError}`));
                }
            });
        });

        // Update step: scoring
        await updatePipelineRun(runId, 'running', 'scoring');

        // Run Node.js pipeline for scoring
        const pipelineProcess = spawn('node', ['pfe-hunter-pipeline.mjs'], {
            cwd: __dirname,
            stdio: 'pipe',
            env: { ...process.env, ...cvEnv }
        });

        let pipelineOutput = '';
        let pipelineError = '';

        pipelineProcess.stdout.on('data', (data) => {
            pipelineOutput += data.toString();
            console.log('[Pipeline]', data.toString());
        });

        pipelineProcess.stderr.on('data', (data) => {
            pipelineError += data.toString();
            console.error('[Pipeline Error]', data.toString());
        });

        await new Promise((resolve, reject) => {
            pipelineProcess.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Pipeline exited with code ${code}: ${pipelineError}`));
                }
            });
        });

        // Get final stats
        const { rows } = await pool.query(
            `SELECT
                (SELECT COUNT(*) FROM job_postings WHERE created_at > (
                    SELECT started_at FROM pipeline_runs WHERE id = $1
                )) as postings_inserted,
                (SELECT COUNT(*) FROM job_postings WHERE scored_at > (
                    SELECT started_at FROM pipeline_runs WHERE id = $1
                )) as postings_scored`, [runId]
        );

        // Mark as success
        await pool.query(
            `UPDATE pipeline_runs
             SET status = 'success',
                 step = 'completed',
                 postings_inserted = $2,
                 postings_scored = $3,
                 finished_at = now(),
                 elapsed_seconds = EXTRACT(EPOCH FROM (now() - started_at))
             WHERE id = $1`, [runId, rows[0].postings_inserted, rows[0].postings_scored]
        );

        currentPipelineRun.status = 'success';
        currentPipelineRun.step = 'completed';
        currentPipelineRun.postings_inserted = parseInt(rows[0].postings_inserted);
        currentPipelineRun.postings_scored = parseInt(rows[0].postings_scored);

        console.log(`Pipeline run ${runId} completed successfully`);

    } catch (err) {
        console.error(`Pipeline run ${runId} failed:`, err);

        // Mark as failed
        await pool.query(
            `UPDATE pipeline_runs
             SET status = 'failed',
                 error_message = $2,
                 finished_at = now(),
                 elapsed_seconds = EXTRACT(EPOCH FROM (now() - started_at))
             WHERE id = $1`, [runId, err.message]
        );

        if (currentPipelineRun && currentPipelineRun.id === runId) {
            currentPipelineRun.status = 'failed';
            currentPipelineRun.error_message = err.message;
        }
    }
}

// Helper to update pipeline run status
async function updatePipelineRun(runId, status, step) {
    await pool.query(
        `UPDATE pipeline_runs SET status = $2, step = $3 WHERE id = $1`, [runId, status, step]
    );

    if (currentPipelineRun && currentPipelineRun.id === runId) {
        currentPipelineRun.status = status;
        currentPipelineRun.step = step;
    }
}

// ---------- START SERVER ----------

async function start() {
    try {
        // Ensure database schema exists
        await ensureSchema();

        // Ensure the Supabase Storage "cvs" bucket exists (no-op if already
        // created, and a no-op warning when Supabase is not configured).
        await ensureCvBucket();

        app.listen(PORT, () => {
            console.log(`PFE Hunter API running on http://localhost:${PORT}`);
            console.log(`Health check: http://localhost:${PORT}/api/health`);
            console.log(API_TOKEN ? 'Auth: token required on all endpoints except /api/health' : 'Auth: DISABLED — set API_TOKEN!');
        });
    } catch (err) {
        console.error('Failed to start API server:', err);
        process.exit(1);
    }
}

start();
