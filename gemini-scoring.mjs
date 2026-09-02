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
//     CV_FILE_PATH=path/to/cv.pdf (or pass as argument to initialize())
//
// Uses @google/genai SDK with Files API for CV upload.

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Module-level state for the uploaded CV file
let uploadedFile = null;
let genAI = null;

/**
 * Initializes the Gemini client and uploads the CV file.
 * Must be called before scorePostingsBatch().
 *
 * @param {string} [cvPathOverride] - Optional path to CV file (overrides CV_FILE_PATH env var)
 * @returns {Promise<void>}
 */
export async function initialize(cvPathOverride) {
    const cvPath = cvPathOverride || process.env.CV_FILE_PATH;

    if (!cvPath) {
        throw new Error('CV_FILE_PATH must be set in .env or passed as an argument.');
    }

    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set in .env.');
    }

    genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    console.log(`Uploading CV from ${cvPath}...`);
    uploadedFile = await genAI.files.upload({
        file: cvPath,
    });

    console.log(`CV uploaded successfully. File URI: ${uploadedFile.uri}`);
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
