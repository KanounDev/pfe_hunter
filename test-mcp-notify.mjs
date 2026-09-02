// test-mcp-notify.mjs — one-off diagnostic: connects to mcp-server.mjs the
// same way gemini-mcp-client.mjs does and calls send_digest_alert with
// sample postings, dumping the FULL result object (not just content[0].text).
// Creates its own test rows in job_postings and deletes them afterwards.
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_POSTINGS = [
    {
        job_id: 'mcp-diag-1',
        title: 'Software Engineer Fullstack - PFE Internship',
        company: 'TestCorp',
        location: 'Paris',
        job_url: 'https://example.com/job/1',
        fit_score: 92,
        fit_reasoning: 'Strong full-stack + AI match.',
    },
    {
        job_id: 'mcp-diag-2',
        title: 'Backend Intern',
        company: 'NoLocation Corp',
        // no location — matches pipeline's `location: p.location || undefined`
        job_url: 'https://example.com/job/2',
        fit_score: 75,
        fit_reasoning: 'Backend match.',
    },
];

// 'normal'        -> well-formed args, exercises the full send path
// 'null-location' -> mimics Gemini sending "location": null (old schema rejected null!)
const mode = process.argv[2] || 'normal';
// webhook config for the CHILD server process:
// 'unset'  -> DISCORD_WEBHOOK_URL removed (dry-run path)
// 'broken' -> unreachable URL (swallowed-failure path)
// 'real'   -> inherit the webhook from .env (real Discord message!)
const webhookMode = process.argv[3] || 'real';

const toolArgs =
    mode === 'null-location'
        ? { postings: TEST_POSTINGS.map((p, i) => (i === 1 ? { ...p, location: null } : p)) }
        : { postings: TEST_POSTINGS };
console.log(`mode: ${mode}, webhook: ${webhookMode}`);

// localhost resolves to both IPv4/IPv6 on this machine and one of the
// listeners speaks TLS — pin IPv4 for a stable local connection.
const dbUrl = (process.env.DATABASE_URL || '').replace('localhost', '127.0.0.1');
const pool = new pg.Pool({ connectionString: dbUrl, ssl: false });

async function seed() {
    for (const p of TEST_POSTINGS) {
        await pool.query(
            `INSERT INTO job_postings (job_id, job_url, title, company, location, description, fit_score, fit_reasoning, notified_at)
             VALUES ($1, $2, $3, $4, $5, 'diagnostic test row', $6, $7, NULL)
             ON CONFLICT (job_id) DO UPDATE SET notified_at = NULL`,
            [p.job_id, p.job_url, p.title, p.company, p.location ?? null, p.fit_score, p.fit_reasoning]
        );
    }
}

async function checkNotified() {
    const { rows } = await pool.query(
        `SELECT job_id, notified_at FROM job_postings WHERE job_id = ANY($1)`,
        [TEST_POSTINGS.map((p) => p.job_id)]
    );
    return rows.map((r) => `${r.job_id}: notified_at=${r.notified_at?.toISOString() ?? 'NULL'}`).join(' | ');
}

async function cleanup() {
    await pool.query(`DELETE FROM job_postings WHERE job_id = ANY($1)`, [TEST_POSTINGS.map((p) => p.job_id)]);
}

let dbReady = false;
try {
    await seed();
    dbReady = true;
} catch (err) {
    console.log('(seed skipped — local DB unavailable:', err.code || err.message, ')');
}
console.log('DISCORD_WEBHOOK_URL in this process:', process.env.DISCORD_WEBHOOK_URL ? `(set, ends ...${process.env.DISCORD_WEBHOOK_URL.slice(-12)})` : '(NOT SET)');

const childEnv = { ...process.env, DATABASE_URL: dbUrl };
if (webhookMode === 'unset') delete childEnv.DISCORD_WEBHOOK_URL;
if (webhookMode === 'broken') childEnv.DISCORD_WEBHOOK_URL = 'http://127.0.0.1:9/hook';

const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, 'mcp-server.mjs')],
    env: childEnv,
});
const client = new Client({ name: 'diagnostic-client', version: '1.0.0' });
await client.connect(transport);

try {
    const result = await client.callTool({
        name: 'send_digest_alert',
        arguments: toolArgs,
    });
    console.log('=== FULL RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    console.log('=== content[0].text (what the client currently logs) ===');
    console.log(JSON.stringify(result.content?.[0]?.text));
    if (dbReady) {
        console.log('=== notified_at AFTER the call ===');
        console.log(await checkNotified());
    }
} catch (err) {
    console.error('=== callTool THREW ===');
    console.error(err);
    if (dbReady) {
        console.log('=== notified_at AFTER the throw ===');
        console.log(await checkNotified());
    }
} finally {
    await client.close();
    if (dbReady) await cleanup();
    await pool.end();
}
