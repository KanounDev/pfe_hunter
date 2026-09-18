// gemini-scoring.mjs
//
// The "LLM Agent — Gemini API" box in the architecture diagram. Takes
// newly-deduped postings (the output of db.mjs's dedupeAndInsert) and
// asks Gemini (or Groq as fallback) to score each one against the candidate's CV (uploaded via
// Files API), returning the same postings with fit_score + fit_reasoning attached.
//
// SETUP:
//   Add to .env:
//     GEMINI_API_KEY=your-key-from-aistudio.google.com
//     GROQ_API_KEY=your-key-from-console.groq.com (fallback for 5xx errors)
//     CV_SUPABASE_URL=<public URL of the CV in Supabase Storage>   (preferred)
//     CV_FILE_PATH=path/to/cv.pdf                                  (legacy/CI)
//     (or pass a path / Supabase URL as an argument to initialize())
//
// Uses @google/genai SDK with Files API for CV upload (Gemini).
// Falls back to groq-sdk for scoring if Gemini returns 5xx errors.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadCvFromStorage } from './supabase-storage.mjs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// Use llama-3.3-70b-versatile - higher token limits and more reliable
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Module-level state for the uploaded CV file
let uploadedFile = null;
let genAI = null;
let groqClient = null;
let cvTextContent = null; // CV text extracted from PDF

/**
 * Resolves the local path of the CV to upload to Gemini.
 *
 * Resolution order:
 *   1. Explicit override argument (local path, kept for tests/CI).
 *   2. CV_SUPABASE_URL env var — the Supabase Storage public URL recorded in
 *      cvs.file_path. The file is downloaded to a temp file first (Render /
 *      serverless hosts have no local copy).
 *   3. CV_FILE_PATH env var — legacy local-disk path (still used by GitHub
 *      Actions, which restores the CV from base64 secrets).
 *
 * @param {string} [cvPathOverride]
 * @returns {Promise<{cvPath: string, tempFile: string|null}>} tempFile must be
 *          deleted by the caller after the Gemini upload completes.
 */
async function resolveCvPath(cvPathOverride) {
    // 1) Explicit override — but if it's a URL, still route through Storage.
    if (cvPathOverride && !/^https?:\/\//i.test(cvPathOverride)) {
        return { cvPath: cvPathOverride, tempFile: null };
    }

    // 2) Supabase URL (override argument or CV_SUPABASE_URL env var).
    const storageUrl = /^https?:\/\//i.test(cvPathOverride || '')
        ? cvPathOverride
        : process.env.CV_SUPABASE_URL;
    if (storageUrl) {
        console.log(`Downloading CV from Supabase Storage...`);
        const buffer = await downloadCvFromStorage(storageUrl);
        const tempFile = path.join(os.tmpdir(), `pfe-hunter-cv-${Date.now()}.pdf`);
        await writeFile(tempFile, buffer);
        console.log(`CV downloaded to temp file (${(buffer.length / 1024).toFixed(1)} KB).`);
        return { cvPath: tempFile, tempFile };
    }

    // 3) Legacy local path.
    if (process.env.CV_FILE_PATH) {
        return { cvPath: process.env.CV_FILE_PATH, tempFile: null };
    }

    throw new Error('No CV source. Set CV_SUPABASE_URL or CV_FILE_PATH in .env, or pass a path to initialize().');
}

/**
 * Extracts text content from a PDF file using pdf-parse.
 * Falls back to raw text reading for non-PDF files.
 *
 * @param {string} cvPath - Path to CV file
 * @returns {Promise<string>} Extracted text content
 */
async function extractCvText(cvPath) {
    const buffer = await readFile(cvPath);

    // Check if it's a PDF
    if (cvPath.toLowerCase().endsWith('.pdf')) {
        try {
            // Dynamic import for pdf-parse (CommonJS module)
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(buffer);
            return data.text;
        } catch (err) {
            console.warn('Failed to parse PDF, treating as text:', err.message);
            // Fall through to text extraction
        }
    }

    // For text files or if PDF parsing fails
    return buffer.toString('utf-8');
}

/**
 * Initializes the Gemini client and uploads the CV file.
 * Also initializes Groq client for fallback scenarios.
 * Must be called before scorePostingsBatch().
 *
 * When the CV lives in Supabase Storage (CV_SUPABASE_URL set) it is
 * downloaded to a temp file first and cleaned up right after the upload.
 *
 * @param {string} [cvPathOverride] - Optional local path or Supabase URL (overrides env vars)
 * @returns {Promise<void>}
 */
export async function initialize(cvPathOverride) {
    // Initialize Groq client FIRST (it's always needed as fallback)
    if (GROQ_API_KEY) {
        groqClient = new Groq({ apiKey: GROQ_API_KEY });
        console.log('Groq API client initialized — will use as fallback for Gemini errors.');
    } else {
        console.warn('⚠️  GROQ_API_KEY not set — no fallback available if Gemini fails.');
    }

    // Resolve CV path
    const { cvPath, tempFile } = await resolveCvPath(cvPathOverride);

    if (!existsSync(cvPath)) {
        throw new Error(`CV file not found at: ${cvPath}`);
    }

    // Extract CV text for Groq fallback BEFORE any Gemini operations
    try {
        cvTextContent = await extractCvText(cvPath);
        console.log(`CV text extracted (${(cvTextContent.length / 1024).toFixed(1)} KB text, ~${Math.ceil(cvTextContent.length / 4)} tokens).`);
    } catch (err) {
        console.warn('Could not extract CV text for fallback:', err.message);
    }

    // Initialize Gemini if API key is available
    if (GEMINI_API_KEY) {
        genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

        try {
            console.log(`Uploading CV to Gemini from ${cvPath}...`);
            uploadedFile = await genAI.files.upload({
                file: cvPath,
            });
            console.log(`CV uploaded successfully to Gemini. File URI: ${uploadedFile.uri}`);
        } catch (err) {
            console.warn(`Failed to upload CV to Gemini: ${err.message}`);
            if (!groqClient || !cvTextContent) {
                throw new Error('Neither Gemini nor Groq is available for scoring.');
            }
            console.log('Will use Groq as primary scorer since Gemini upload failed.');
        }
    } else {
        console.log('GEMINI_API_KEY not set — using Groq as primary scorer.');
        if (!groqClient) {
            throw new Error('Neither GEMINI_API_KEY nor GROQ_API_KEY is set.');
        }
    }

    // Clean up temp file
    if (tempFile) {
        await unlink(tempFile).catch(() => {});
    }
}

/**
 * Cleans up the uploaded CV file from Gemini's file storage.
 * Call this after all scoring is complete to avoid file accumulation.
 */
export async function cleanup() {
    if (uploadedFile && genAI) {
        try {
            await genAI.files.delete({ name: uploadedFile.name });
            console.log('CV file deleted from Gemini storage.');
        } catch (err) {
            console.warn('Failed to delete uploaded CV file:', err.message);
        }
        uploadedFile = null;
    }
}

function buildPrompt(postings, includeCv = false) {
    const jobsBlock = postings
        .map(
            (p) =>
            `- job_id: ${p.job_id}\n  title: ${p.title}\n  company: ${p.company}\n  location: ${p.location}\n  description: ${(p.description || '').slice(0, 600)}`
        )
        .join('\n\n');

    const cvSection = includeCv ? `\n\nCANDIDATE CV:\n${cvTextContent.slice(0, 8000)}\n` : '';

    return `${cvSection}You are screening job postings for fit against the candidate's CV document provided above.

For EACH posting below, give:
- fit_score: an integer 0-100 (100 = perfect match)
- fit_reasoning: one short sentence explaining the score

Postings:
${jobsBlock}

Respond with ONLY a JSON array, no markdown fences, no extra text, in exactly this shape:
[{"job_id": "job_001", "fit_score": 85, "fit_reasoning": "..."}]`;
}

/**
 * Scores a batch of postings with Groq using the CV text.
 * Uses OpenAI-compatible chat.completions API.
 *
 * @param {Array} postings - deduped postings (job_id, title, company, ...)
 * @returns {Promise<Array>} same postings + fit_score + fit_reasoning
 */
export async function scorePostingsBatchGroq(postings) {
    if (!groqClient) {
        throw new Error('Groq client not initialized. Set GROQ_API_KEY in .env.');
    }

    if (!cvTextContent) {
        throw new Error('CV content not available for Groq scoring.');
    }

    // Process in smaller batches to avoid token limits
    // Rough estimate: ~4 chars per token, limit ~6000 tokens for input
    const MAX_BATCH_TOKENS = 5000;
    const results = [];

    for (let i = 0; i < postings.length; i += 5) {
        const batch = postings.slice(i, i + 5);
        const prompt = buildPrompt(batch, true);

        console.log(`🔄 Scoring batch ${Math.floor(i/5) + 1} with Groq (${GROQ_MODEL})...`);

        const response = await groqClient.chat.completions.create({
            model: GROQ_MODEL,
            messages: [
                {
                    role: 'system',
                    content: 'You are a job matching assistant. Analyze job postings against candidate CVs and provide fit scores. Always respond with valid JSON only, no markdown fences.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.3,
            max_tokens: 1024,
        });

        const text = response?.choices?.[0]?.message?.content;
        if (!text) {
            throw new Error('Groq returned no scoreable text content.');
        }

        // Clean up response - remove markdown fences if present
        let cleanedText = text.trim();
        if (cleanedText.startsWith('```json')) {
            cleanedText = cleanedText.slice(7);
        } else if (cleanedText.startsWith('```')) {
            cleanedText = cleanedText.slice(3);
        }
        if (cleanedText.endsWith('```')) {
            cleanedText = cleanedText.slice(0, -3);
        }
        cleanedText = cleanedText.trim();

        let scores;
        try {
            scores = JSON.parse(cleanedText);
        } catch (err) {
            throw new Error(`Could not parse Groq's JSON output: ${err.message}\nRaw response: ${text}`);
        }

        if (!Array.isArray(scores)) {
            throw new Error(`Groq returned non-array response: ${JSON.stringify(scores)}`);
        }

        const scoreByJobId = new Map(scores.map((s) => [s.job_id, s]));

        const batchResults = batch.map((p) => {
            const s = scoreByJobId.get(p.job_id);
            return {
                ...p,
                fit_score: s?.fit_score ?? null,
                fit_reasoning: s?.fit_reasoning ?? null,
            };
        });

        results.push(...batchResults);

        // Small delay between batches to respect rate limits
        if (i + 5 < postings.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    return results;
}

/**
 * Scores a batch of postings with Gemini using the uploaded CV file context
 * and merges fit_score/fit_reasoning back onto each posting.
 * If Gemini fails (any error), falls back to Groq if available.
 * Matches postings to scores by job_id, so the order doesn't matter.
 *
 * IMPORTANT: Call initialize() first to upload the CV file.
 *
 * @param {Array} postings - deduped postings (job_id, title, company, ...)
 * @returns {Promise<Array>} same postings + fit_score + fit_reasoning
 */
export async function scorePostingsBatch(postings) {
    if (postings.length === 0) return [];

    // If Gemini is not available, use Groq directly
    if (!uploadedFile || !genAI) {
        if (groqClient && cvTextContent) {
            console.log('Gemini not available, using Groq as primary scorer...');
            return scorePostingsBatchGroq(postings);
        }
        throw new Error('No scoring service available. Neither Gemini nor Groq is initialized.');
    }

    const prompt = buildPrompt(postings, false);

    try {
        console.log(`📊 Scoring ${postings.length} postings with Gemini (${GEMINI_MODEL})...`);

        const response = await genAI.models.generateContent({
            model: GEMINI_MODEL,
            contents: [{
                role: 'user',
                parts: [{
                        fileData: {
                            mimeType: uploadedFile.mimeType,
                            fileUri: uploadedFile.uri,
                        },
                    },
                    { text: prompt },
                ],
            }, ],
            config: {
                responseMimeType: 'application/json',
            },
        });

        const text = response?.text;
        if (!text) {
            throw new Error('Gemini returned no scoreable text content.');
        }

        let scores;
        try {
            scores = JSON.parse(text);
        } catch (err) {
            throw new Error(`Could not parse Gemini's JSON output: ${err.message}\nRaw response: ${text}`);
        }

        const scoreByJobId = new Map(scores.map((s) => [s.job_id, s]));

        return postings.map((p) => {
            const s = scoreByJobId.get(p.job_id);
            return {
                ...p,
                fit_score: s?.fit_score ?? null,
                fit_reasoning: s?.fit_reasoning ?? null,
            };
        });
    } catch (err) {
        // Fall back to Groq for ANY error (503, timeout, rate limit, etc.)
        if (groqClient && cvTextContent) {
            console.warn(`⚠️  Gemini error (${err.status || 'unknown'}): ${err.message}`);
            console.log('Falling back to Groq...');
            return scorePostingsBatchGroq(postings);
        }
        throw err;
    }
}
