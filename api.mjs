// api.mjs
//
// Backend API for PFE Hunter Dashboard.
// Express server that connects to Postgres and serves data to the React frontend.
//
// ENDPOINTS:
//   GET /api/postings     - List all postings (with filters)
//   GET /api/postings/:id - Get single posting
//   GET /api/stats        - Get aggregated statistics
//   GET /api/runs         - Get recent run history
//   GET /api/health       - Health check
//   POST /api/cv/upload   - Upload CV file
//   GET /api/cv           - Get current CV info
//   DELETE /api/cv        - Delete CV
//
// SETUP:
//   npm install express cors pg dotenv multer
//   node api.mjs

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import { pool, ensureSchema } from './db.mjs';
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = process.env.API_PORT || 3001;
const API_TOKEN = process.env.API_TOKEN;
const __dirname = path.dirname(fileURLToPath(
    import.meta.url));
const CV_UPLOAD_DIR = path.join(__dirname, 'uploads', 'cvs');

// Track pipeline run status in memory
let currentPipelineRun = null;

// Security middleware
app.use(helmet());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

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

// Authentication middleware
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || token !== API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Configure multer for CV uploads
// Sanitize filename to prevent path traversal
const sanitizeFilename = (filename) => {
    return path.basename(filename).replace(/[^a-zA-Z0-9.-]/g, '_');
};

// Verify extension matches MIME type
const extToMime = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

const storage = multer.diskStorage({
    destination: async(req, file, cb) => {
        // Ensure upload directory exists
        if (!existsSync(CV_UPLOAD_DIR)) {
            await mkdir(CV_UPLOAD_DIR, { recursive: true });
        }
        cb(null, CV_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        // Generate unique filename with timestamp
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'cv-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        // Accept PDFs and common document formats
        const allowedMimes = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];
        const allowedExts = ['.pdf', '.doc', '.docx'];
        const ext = path.extname(file.originalname).toLowerCase();

        // Check if extension matches MIME type
        if (file.mimetype !== extToMime[ext]) {
            return cb(new Error('File extension does not match content type'));
        }

        if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PDF and Word documents are allowed.'));
        }
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

// Health check
app.get('/api/health', async(req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected' });
    } catch (err) {
        res.status(503).json({ status: 'error', database: 'disconnected', error: err.message });
    }
});

// Get all postings with filters
app.get('/api/postings', async(req, res) => {
    try {
        const { minScore, maxScore, company, location, notified, sort, order, limit, offset } = req.query;

        let sql = 'SELECT * FROM job_postings WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        // Fit score filter with validation
        if (minScore !== undefined) {
            const score = parseInt(minScore);
            if (isNaN(score) || score < 0 || score > 100) {
                return res.status(400).json({ error: 'minScore must be between 0 and 100' });
            }
            sql += ` AND fit_score >= $${paramIndex++}`;
            params.push(score);
        }
        if (maxScore !== undefined) {
            const score = parseInt(maxScore);
            if (isNaN(score) || score < 0 || score > 100) {
                return res.status(400).json({ error: 'maxScore must be between 0 and 100' });
            }
            sql += ` AND fit_score <= $${paramIndex++}`;
            params.push(score);
        }

        // Company filter (case-insensitive partial match)
        if (company) {
            sql += ` AND company ILIKE $${paramIndex++}`;
            params.push(`%${company}%`);
        }

        // Location filter (case-insensitive partial match)
        if (location) {
            sql += ` AND location ILIKE $${paramIndex++}`;
            params.push(`%${location}%`);
        }

        // Notification status filter
        if (notified === 'notified') {
            sql += ' AND notified_at IS NOT NULL';
        } else if (notified === 'not-notified') {
            sql += ' AND notified_at IS NULL';
        }

        // Sorting with strict whitelist
        const ALLOWED_SORTS = {
            'fit_score': 'fit_score',
            'created_at': 'created_at',
            'company': 'company',
            'title': 'title'
        };
        const sortField = ALLOWED_SORTS[sort] || 'created_at';
        const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
        sql += ` ORDER BY ${sortField} ${sortOrder}`;

        // Pagination with validation
        const limitVal = limit ? Math.min(Math.max(parseInt(limit), 1), 100) : 100;
        const offsetVal = offset ? Math.max(parseInt(offset), 0) : 0;
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
        const { id } = req.params;
        const { rows } = await pool.query(
            'SELECT * FROM job_postings WHERE job_id = $1', [id]
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

// Get recent run history
app.get('/api/runs', async(req, res) => {
    try {
        const { limit } = req.query;
        const limitVal = limit ? Math.min(parseInt(limit), 50) : 10;

        // Read from periodic_run_log.json
        const { readFile } = await
        import ('node:fs/promises');
        const { existsSync } = await
        import ('node:fs');
        const path = await
        import ('node:path');

        const logFile = path.join(process.cwd(), 'periodic_run_log.json');

        if (!existsSync(logFile)) {
            return res.json([]);
        }

        const content = await readFile(logFile, 'utf-8');

        // Safe JSON parsing with error handling
        let runs;
        try {
            runs = JSON.parse(content);
        } catch (parseError) {
            console.error('Failed to parse run log:', parseError);
            return res.json([]); // Return empty array on error
        }

        // Return most recent runs
        res.json(runs.slice(-limitVal).reverse());
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
        const { key } = req.params;
        const { value } = req.body;

        if (value === undefined) {
            return res.status(400).json({ error: 'Value is required' });
        }

        // Validate setting key
        const validKeys = [
            'scrape_interval_minutes',
            'results_wanted',
            'hours_old',
            'search_terms',
            'locations',
            'job_sites',
            'title_keywords',
            'fit_score_threshold',
        ];

        if (!validKeys.includes(key)) {
            return res.status(400).json({ error: `Invalid setting key: ${key}` });
        }

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
        const { settings } = req.body;

        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: 'Settings object is required' });
        }

        const client = await pool.connect();
        const updated = [];

        try {
            await client.query('BEGIN');

            for (const [key, value] of Object.entries(settings)) {
                // Validate
                const validationError = validateSetting(key, value);
                if (validationError) {
                    throw new Error(`Invalid setting ${key}: ${validationError}`);
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
        res.status(500).json({ error: err.message || 'Failed to update settings' });
    }
});

// Reset settings to defaults (requires authentication)
app.post('/api/settings/reset', authMiddleware, async(req, res) => {
    try {
        const defaults = {
            scrape_interval_minutes: '300',
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
        case 'scrape_interval_minutes':
            const interval = parseInt(value);
            if (isNaN(interval) || interval < 5 || interval > 1440) {
                return 'scrape_interval_minutes must be between 5 and 1440 (24 hours)';
            }
            break;

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

// Upload CV file (requires authentication)
app.post('/api/cv/upload', authMiddleware, upload.single('cv'), async(req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Deactivate any existing active CVs
            await client.query('UPDATE cvs SET is_active = false WHERE is_active = true');

            // Insert new CV record
            const { rows } = await client.query(
                `INSERT INTO cvs (filename, original_name, file_path, file_size, mime_type, is_active)
                 VALUES ($1, $2, $3, $4, $5, true)
                 RETURNING id, filename, original_name, file_size, mime_type, uploaded_at`, [
                    req.file.filename,
                    req.file.originalname,
                    req.file.path,
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
            // Delete uploaded file if database insert failed
            await unlink(req.file.path).catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error uploading CV:', err);
        res.status(500).json({ error: 'Failed to upload CV' });
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

        if (!existsSync(cv.file_path)) {
            return res.status(404).json({ error: 'CV file not found on disk' });
        }

        const fileContent = await readFile(cv.file_path);

        // Sanitize filename for Content-Disposition header
        const sanitizedFilename = cv.original_name.replace(/["\r\n]/g, '');
        res.setHeader('Content-Type', cv.mime_type);
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);
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

            // Delete file from filesystem
            if (existsSync(cv.file_path)) {
                await unlink(cv.file_path);
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
            return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
        }
        return res.status(400).json({ error: error.message });
    } else if (error) {
        return res.status(400).json({ error: error.message });
    }
    next();
});

// ---------- PIPELINE MANAGEMENT ROUTES ----------

// Trigger immediate pipeline run (requires authentication)
app.post('/api/pipeline/trigger', authMiddleware, async(req, res) => {
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
        const { limit } = req.query;
        const limitVal = limit ? Math.min(parseInt(limit), 50) : 20;

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
        // disk and records the path in the `cvs` table; pass that path to the
        // pipeline child process via CV_FILE_PATH (the child has no other way
        // of discovering it).
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

        const cvFilePath = path.resolve(cvRows[0].file_path);
        if (!existsSync(cvFilePath)) {
            throw new Error(`CV file missing on disk: ${cvFilePath}. The service filesystem is ephemeral on Render — re-upload your CV after every deploy/restart.`);
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
            env: { ...process.env, CV_FILE_PATH: cvFilePath }
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

        app.listen(PORT, () => {
            console.log(`PFE Hunter API running on http://localhost:${PORT}`);
            console.log(`Health check: http://localhost:${PORT}/api/health`);
        });
    } catch (err) {
        console.error('Failed to start API server:', err);
        process.exit(1);
    }
}

start();
