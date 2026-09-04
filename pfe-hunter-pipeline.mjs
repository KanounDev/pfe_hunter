// pfe-hunter-pipeline.mjs
//
// Unified, production end-to-end PFE Hunter pipeline.
//
// NEW FLOW (no intermediate JSON file):
//   1. Python scraper (scrape_jobspy.py) writes DIRECTLY to Postgres with dedup
//   2. This pipeline queries for unscored postings from Postgres
//   3. Score new postings against the CV (Gemini Files API)
//   4. Save scores back to Postgres
//   5. Hand scored postings to Gemini via MCP to decide on Discord alert
//
// SETUP:
//   1. Run the scraper first: python scrape_jobspy.py
//      (writes directly to Postgres, no JSON file)
//   2. npm install pg dotenv @google/genai @modelcontextprotocol/sdk zod
//   3. .env needs:
//        DATABASE_URL=postgres://user:password@localhost:5432/pfe_hunter
//        GEMINI_API_KEY=...
//        GEMINI_MODEL=...            (optional — used by gemini-mcp-client.mjs)
//        CV_FILE_PATH=...            (optional — defaults to the CV in this folder)
//        DISCORD_WEBHOOK_URL=...     (optional — dry-runs if unset)
//   4. node pfe-hunter-pipeline.mjs
//
// Intended to run on the 6-hourly schedule (cron / GitHub Action).

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { ensureSchema, getUnscoredPostings, saveScores, closePool, getSetting, getActiveCvPath } from './db.mjs';
import { scorePostingsBatch, initialize as initScoring, cleanup as cleanupScoring } from './gemini-scoring.mjs';
import { notifyViaMcp } from './gemini-mcp-client.mjs';
import { sendPipelineFailureAlert } from './notifications.mjs';

// ---------- 1. LOAD UNSCORED POSTINGS ----------

/**
 * Queries Postgres for all postings that haven't been scored yet.
 * The Python scraper already inserted new postings with deduplication,
 * so this just picks up the unscored ones.
 */
async function loadUnscoredPostings() {
    console.log('Querying for unscored postings from Postgres...');
    const postings = await getUnscoredPostings();
    console.log(`Found ${postings.length} unscored posting(s).`);
    return postings;
}

// ---------- 2. SCORE + PERSIST ----------

/**
 * Scores every unscored posting against the CV and writes the scores
 * back to Postgres. Deliberately NOT capped at some max-per-run count:
 * a row skipped here would sit forever with fit_score = NULL.
 */
async function scoreAndPersist(postings) {
    if (postings.length === 0) {
        console.log('Nothing to score — skipping Gemini call.');
        return [];
    }

    console.log(`Scoring ${postings.length} posting(s) with Gemini...`);
    const scored = await scorePostingsBatch(postings);

    for (const p of scored) {
        console.log(`  [${p.fit_score ?? 'null'}] ${p.title} @ ${p.company ?? 'Unknown'} — ${p.fit_reasoning ?? 'no reasoning returned'}`);
    }

    await saveScores(scored);
    console.log('Scores saved to Postgres.');

    return scored;
}

// ---------- 3. NOTIFY ----------

async function notify(scored) {
    if (scored.length === 0) {
        console.log('No scored postings to hand to the agent — skipping.');
        return;
    }

    // Read fit_score_threshold from database settings
    const thresholdStr = await getSetting('fit_score_threshold', '70');
    const fitScoreThreshold = parseInt(thresholdStr, 10) || 70;
    console.log(`Using fit_score_threshold: ${fitScoreThreshold}`);

    // send_digest_alert's input schema (mcp-server.mjs) requires company as
    // a non-null string, but the DB allows it to be null. Substituting a
    // fallback here only affects what the digest message shows.
    const forNotify = scored.map((p) => ({
        ...p,
        company: p.company || 'Unknown company',
        location: p.location || undefined,
    }));

    console.log('Handing scored postings to Gemini via real MCP...');
    await notifyViaMcp(forNotify, fitScoreThreshold);
}

// ---------- 4. RUN ----------

async function main() {
    let step = 'schema';

    try {
        await ensureSchema();

        step = 'cv-upload';
        // CV resolution order: CV_FILE_PATH env var (set in CI) →
        // CV_SUPABASE_URL env var (set by api.mjs when it spawns this
        // pipeline) → the CV uploaded via the dashboard (its Supabase URL is
        // stored in the `cvs` table). gemini-scoring.mjs downloads URLs to a
        // temp file before uploading to Gemini.
        let cvRef = process.env.CV_FILE_PATH || process.env.CV_SUPABASE_URL;
        if (!cvRef) {
            cvRef = await getActiveCvPath();
            if (cvRef) {
                console.log(`No CV env var set — using CV uploaded via dashboard: ${cvRef}`);
            }
        }
        if (!cvRef) {
            throw new Error('No CV available. Set CV_FILE_PATH in the environment or upload a CV via the dashboard Settings page.');
        }
        // Supabase URLs aren't on disk — existence is verified at download time.
        if (!/^https?:\/\//i.test(cvRef) && !existsSync(cvRef)) {
            throw new Error(`CV file not found on disk at "${cvRef}". If the service was redeployed, the uploaded file was wiped (ephemeral filesystem) — re-upload the CV in the dashboard Settings page.`);
        }
        await initScoring(cvRef);

        step = 'load';
        const postings = await loadUnscoredPostings();

        if (postings.length === 0) {
            console.log('No unscored postings found — nothing to do this run.');
            return;
        }

        step = 'scoring';
        const scored = await scoreAndPersist(postings);

        step = 'mcp-notify';
        await notify(scored);

        console.log('\n✅ Pipeline run complete.');
    } catch (err) {
        console.error(`Pipeline failed at step "${step}":`, err);
        await sendPipelineFailureAlert(step, err).catch((alertErr) =>
            console.error('Also failed to send the pipeline-failure alert itself:', alertErr)
        );
        process.exitCode = 1;
    } finally {
        await cleanupScoring().catch((err) =>
            console.warn('Failed to cleanup CV file:', err.message)
        );
        await closePool();
    }
}

main();
