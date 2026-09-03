// mcp-server.mjs
//
// A REAL MCP server — the actual protocol, not just a plain function.
// Exposes ONE tool, send_digest_alert, over stdio using the official MCP
// TypeScript SDK. Any MCP-compatible client (including our own
// gemini-mcp-client.mjs) can connect to this process, ask it "what tools
// do you have?", and call them — without hardcoding the tool's shape on
// the client side.
//
// You never run this file directly. gemini-mcp-client.mjs spawns it
// automatically as a subprocess and talks to it over stdin/stdout — that
// subprocess-plus-stdin/stdout link is what "stdio transport" means.
//
// SETUP:
//   npm install @modelcontextprotocol/sdk zod

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendDigestAlert } from './notifications.mjs';
import { filterUnnotified, markNotified } from './db.mjs';

const server = new McpServer({ name: 'pfe-hunter-notifier', version: '1.0.0' });

// Mirrors the threshold gemini-mcp-client.mjs puts into its prompt to
// Gemini. Kept as its own literal here (not imported) on purpose: this
// check exists BECAUSE we don't want to fully trust that the prompt was
// honored — Gemini could still hand back a borderline or misformatted
// posting, so the server re-checks for itself instead of trusting the
// caller's math.
const FIT_SCORE_THRESHOLD = 70;

server.registerTool(
    'send_digest_alert',
    {
        title: 'Send Digest Alert',
        description:
            'Send a Discord digest listing job postings that are a strong fit for the candidate. ' +
            'Call this once with ALL qualifying postings batched together, not once per posting. ' +
            'Only call this for postings that are genuinely good matches.',
        inputSchema: {
            postings: z.array(
                z.object({
                    job_id: z.string(),
                    title: z.string(),
                    company: z.string(),
                    // Gemini emits "location": null (not absent) for postings
                    // without a location — .optional() alone rejects null and
                    // kills the WHOLE digest over one missing field.
                    location: z.string().nullish(),
                    job_url: z.string(),
                    // Tolerate fit_score arriving as "85" instead of 85.
                    fit_score: z.coerce.number(),
                    fit_reasoning: z.string().nullish(),
                })
            ),
        },
    },
    async ({ postings }) => {
        try {
            // Diagnostics go to stderr: StdioClientTransport forwards the
            // subprocess' stderr to the pipeline's stderr, which api.mjs logs
            // — so these lines show up in Render's logs.
            console.error(`[send_digest_alert] called with ${postings.length} posting(s)`);

            // Defense-in-depth #1: re-check the fit_score threshold in code
            // rather than relying solely on the prompt instruction Gemini was
            // given.
            const qualifying = postings.filter(
                (p) => typeof p.fit_score === 'number' && p.fit_score >= FIT_SCORE_THRESHOLD
            );
            const belowThreshold = postings.length - qualifying.length;
            console.error(`[send_digest_alert] qualifying=${qualifying.length}, belowThreshold=${belowThreshold}`);

            // Defense-in-depth #2: never alert twice on the same posting. If
            // this call is happening because a run got retried after a partial
            // failure, some of these may have already been alerted on
            // successfully in an earlier attempt.
            const stillUnnotified = new Set(await filterUnnotified(qualifying.map((p) => p.job_id)));
            const toSend = qualifying.filter((p) => stillUnnotified.has(p.job_id));
            const alreadyNotified = qualifying.length - toSend.length;
            console.error(`[send_digest_alert] toSend=${toSend.length}, alreadyNotified=${alreadyNotified}`);

            if (toSend.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Nothing sent — ${belowThreshold} posting(s) below the fit_score threshold, ${alreadyNotified} already notified or not found in the database.`,
                        },
                    ],
                };
            }

            const result = await sendDigestAlert(toSend);
            console.error(
                `[send_digest_alert] sendDigestAlert → ${JSON.stringify({
                    dryRun: result.dryRun,
                    ok: result.ok,
                    results: result.results,
                })}`
            );

            // A dry run never told anyone anything — report it clearly.
            if (result.dryRun) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `DRY RUN — no notification channel configured (set DISCORD_WEBHOOK_URL). Payload would have been:\n${result.text}`,
                        },
                    ],
                };
            }

            // Only stamp notified_at once a channel ACTUALLY delivered — a failed
            // send must never be reported (or recorded) as success, otherwise the
            // postings would be skipped forever and never re-alerted.
            if (!result.ok) {
                const failures = Array.isArray(result.results) ? result.results.filter((r) => !r.ok) : [];
                const errors = failures.map((r) => `${r.channel}: ${r.error || 'unknown error'}`).join(' | ');
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: `FAILED to send digest — no channel delivered. ${errors || JSON.stringify(result.results ?? [])}`,
                        },
                    ],
                };
            }

            await markNotified(toSend.map((p) => p.job_id));

            const skippedNote =
                belowThreshold || alreadyNotified
                    ? ` (skipped ${belowThreshold} below threshold, ${alreadyNotified} already notified)`
                    : '';

            return {
                content: [
                    {
                        type: 'text',
                        text: `Sent to Discord successfully. ${toSend.length} posting(s) included.${skippedNote}`,
                    },
                ],
            };
        } catch (err) {
            // The MCP SDK wraps handler exceptions as
            // createToolError(error.message) — an Error with an EMPTY message
            // becomes the silent {"text":""} error result seen in run 12.
            // Guarantee that never happens again: log the full stack to
            // stderr and return the most informative non-empty detail we can
            // (pg errors, for example, sometimes carry only a `.code`).
            const detail =
                err?.stack ||
                `${err?.message || ''}${err?.code ? ` (code ${err.code})` : ''}`.trim() ||
                String(err) ||
                'unknown error';
            console.error(`[send_digest_alert] EXCEPTION: ${detail}`);
            return {
                isError: true,
                content: [
                    {
                        type: 'text',
                        text: `send_digest_alert failed: ${detail}`,
                    },
                ],
            };
        }
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
