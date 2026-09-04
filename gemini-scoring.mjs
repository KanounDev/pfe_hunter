// gemini-scoring.mjs
//
// The "LLM Agent — Gemini API" box in the architecture diagram. Takes
// newly-deduped postings (the output of db.mjs's dedupeAndInsert) and
// asks Gemini to score each one against the candidate's CV (uploaded via
// Files API), returning the same postings with fit_score + fit_reasoning attached.
//
// SETUP:
//   Add to .env:
//     GEMINI_API_KEY=your-key-from-aistudio.google.com
//     CV_SUPABASE_URL=<public URL of the CV in Supabase Storage>   (preferred)
//     CV_FILE_PATH=path/to/cv.pdf                                  (legacy/CI)
//     (or pass a path / Supabase URL as an argument to initialize())
//
// Uses @google/genai SDK with Files API for CV upload.

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadCvFromStorage } from './supabase-storage.mjs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Module-level state for the uploaded CV file
let uploadedFile = null;
let genAI = null;

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
 * Initializes the Gemini client and uploads the CV file.
 * Must be called before scorePostingsBatch().
 *
 * When the CV lives in Supabase Storage (CV_SUPABASE_URL set) it is
 * downloaded to a temp file first and cleaned up right after the upload.
 *
 * @param {string} [cvPathOverride] - Optional local path or Supabase URL (overrides env vars)
 * @returns {Promise<void>}
 */
export async function initialize(cvPathOverride) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set in .env.');
    }

    const { cvPath, tempFile } = await resolveCvPath(cvPathOverride);

    if (!existsSync(cvPath)) {
        throw new Error(`CV file not found at: ${cvPath}`);
    }

    genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    try {
        console.log(`Uploading CV from ${cvPath}...`);
        uploadedFile = await genAI.files.upload({
            file: cvPath,
        });

        console.log(`CV uploaded successfully. File URI: ${uploadedFile.uri}`);
    } finally {
        // Remove the downloaded temp file — Gemini has its own copy now.
        if (tempFile) {
            await unlink(tempFile).catch(() => {});
        }
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

function buildPrompt(postings) {
    const jobsBlock = postings
        .map(
            (p) =>
            `- job_id: ${p.job_id}\n  title: ${p.title}\n  company: ${p.company}\n  location: ${p.location}\n  description: ${(p.description || '').slice(0, 800)}`
        )
        .join('\n\n');

    return `You are screening job postings for fit against the candidate's CV document provided above.

For EACH posting below, give:
- fit_score: an integer 0-100 (100 = perfect match)
- fit_reasoning: one short sentence explaining the score

Postings:
${jobsBlock}

Respond with ONLY a JSON array, no markdown fences, no extra text, in exactly this shape:
[{"job_id": "job_001", "fit_score": 85, "fit_reasoning": "..."}]`;
}

/**
 * Scores a batch of postings with Gemini using the uploaded CV file context
 * and merges fit_score/fit_reasoning back onto each posting.
 * Matches postings to scores by job_id, so the order Gemini returns them in doesn't matter.
 *
 * IMPORTANT: Call initialize() first to upload the CV file.
 *
 * @param {Array} postings - deduped postings (job_id, title, company, ...)
 * @returns {Promise<Array>} same postings + fit_score + fit_reasoning
 */
export async function scorePostingsBatch(postings) {
    if (postings.length === 0) return [];

    if (!uploadedFile) {
        throw new Error('CV file not uploaded. Call initialize() first.');
    }

    if (!genAI) {
        throw new Error('Gemini client not initialized. Call initialize() first.');
    }

    const prompt = buildPrompt(postings);

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
}
