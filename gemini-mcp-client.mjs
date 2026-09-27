// gemini-mcp-client.mjs
//
// The REAL MCP client. This is what actually makes this "real MCP"
// instead of the hand-wired version we had before:
//
//   1. It launches mcp-server.mjs as a subprocess and talks to it using
//      the real MCP protocol over stdio — not a plain JS import.
//   2. It DISCOVERS the tool by asking the server "what tools do you
//      have?" (listTools()) instead of us hardcoding a schema by hand.
//   3. Gemini itself decides whether to call the tool — based on the
//      scored postings and instructions we give it — not a JS filter
//      like shouldTriggerTool().
//   4. When Gemini decides to call it, we forward that exact call through
//      the MCP client, which sends it to the server over the protocol.
//
// SETUP:
//   npm install @modelcontextprotocol/sdk
//   .env needs GEMINI_API_KEY (same one gemini-scoring.mjs already uses)

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Groq from 'groq-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const DEFAULT_FIT_SCORE_THRESHOLD = 70;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000; // 1s, then 2s, then 4s

// Initialize Groq client for fallback
let groqClient = null;
if (GROQ_API_KEY) {
    groqClient = new Groq({ apiKey: GROQ_API_KEY });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gemini's function-calling API expects a small subset of JSON Schema
 * (close to OpenAPI's schema format). The MCP SDK generates FULL JSON
 * Schema from zod, which includes extra fields like "$schema" and
 * "additionalProperties" that Gemini's API doesn't recognize and will
 * reject the whole request over. This strips anything Gemini can't
 * handle, recursively (in case a nested object/array has the same
 * fields).
 *
 * It ALSO collapses the two shapes zod uses for nullable fields —
 *   anyOf: [ { type: 'string' }, { type: 'null' } ]
 *   type:  ['string', 'null']
 * — into Gemini's native representation, `nullable: true`. Both shapes
 * crash the Gemini request with 400 "Proto field is not repeating,
 * cannot start list" when they appear inside function declarations.
 */
export function sanitizeSchemaForGemini(schema) {
    if (Array.isArray(schema)) {
        return schema.map(sanitizeSchemaForGemini);
    }
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    let working = schema;

    if (Array.isArray(working.anyOf)) {
        const branches = working.anyOf.map(sanitizeSchemaForGemini);
        const nullBranches = branches.filter((b) => b && b.type === 'null');
        const realBranches = branches.filter((b) => !(b && b.type === 'null'));

        // Merge the first real branch into this schema; if a null branch
        // exists, express it with Gemini's own `nullable: true`.
        const merged = { ...working, ...(realBranches[0] ?? {}) };
        delete merged.anyOf;
        if (nullBranches.length > 0) {
            merged.nullable = true;
        } else {
            delete merged.nullable;
        }
        working = merged;
    }

    if (Array.isArray(working.type)) {
        const isNullable = working.type.includes('null');
        const realTypes = working.type.filter((t) => t !== 'null');
        working = {
            ...working,
            type: realTypes[0] ?? 'string',
            ...(isNullable ? { nullable: true } : {}),
        };
    }

    const { $schema, additionalProperties, ...rest } = working;
    for (const key of Object.keys(rest)) {
        rest[key] = sanitizeSchemaForGemini(rest[key]);
    }
    return rest;
}

/**
 * Converts an MCP tool's schema (as returned by listTools()) into the
 * shape Gemini's function-calling API expects. Gemini doesn't speak MCP
 * natively, so this small translation is the "bridge" between the two —
 * this is the piece that wouldn't exist if Gemini had built-in MCP
 * support.
 */
export function mcpToolToGeminiDeclaration(mcpTool) {
    return {
        name: mcpTool.name,
        description: mcpTool.description,
        parameters: sanitizeSchemaForGemini(mcpTool.inputSchema),
    };
}

/**
 * Converts MCP tool schema to OpenAI-compatible function format for Groq.
 * Groq uses the same function-calling format as OpenAI.
 */
export function mcpToolToGroqTool(mcpTool) {
    return {
        type: 'function',
        function: {
            name: mcpTool.name,
            description: mcpTool.description,
            parameters: sanitizeSchemaForGemini(mcpTool.inputSchema), // Same sanitization works
        },
    };
}

/**
 * Fallback to Groq when Gemini fails (503, rate limits, etc.).
 * Groq uses OpenAI-compatible function calling.
 */
async function callGroq(contents, groqTools) {
    if (!groqClient) {
        throw new Error('Groq API key not configured (GROQ_API_KEY missing from .env)');
    }

    // Convert Gemini contents format to OpenAI messages format
    const messages = contents.map(c => ({
        role: c.role === 'user' ? 'user' : 'assistant',
        content: c.parts.map(p => p.text).join('\n'),
    }));

    const response = await groqClient.chat.completions.create({
        model: GROQ_MODEL,
        messages,
        tools: groqTools,
        tool_choice: 'auto',
    });

    // Convert Groq response to Gemini-like format for consistent handling downstream
    const choice = response.choices[0];
    if (!choice) {
        throw new Error('Groq returned no choices');
    }

    // Convert OpenAI function calls to Gemini-like format
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        const toolCall = choice.message.tool_calls[0];
        return {
            candidates: [{
                content: {
                    parts: [{
                        functionCall: {
                            name: toolCall.function.name,
                            args: JSON.parse(toolCall.function.arguments),
                        },
                    }],
                },
            }],
        };
    }

    // No tool call - return empty parts (Gemini-style)
    return {
        candidates: [{
            content: {
                parts: [{ text: choice.message.content || '' }],
            },
        }],
    };
}

// Wrapped with retry/backoff with Groq fallback — previously a single transient
// failure here (timeout, a flaky 5xx, etc.) killed the whole run even though the
// scraping, dedup, and scoring stages that got us this far all succeeded.
async function callGemini(contents, geminiTools) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents,
                        tools: [{ functionDeclarations: geminiTools }],
                    }),
                }
            );
            if (!res.ok) {
                throw new Error(`Gemini request failed: ${res.status} ${await res.text()}`);
            }
            return await res.json();
        } catch (err) {
            lastError = err;
            // Check if error is retryable (5xx errors, network issues)
            const isRetryable = err.message.includes('503') ||
                                err.message.includes('502') ||
                                err.message.includes('500') ||
                                err.message.includes('ECONNREFUSED') ||
                                err.message.includes('ETIMEDOUT');

            if (attempt < MAX_RETRIES && isRetryable) {
                const wait = RETRY_BACKOFF_MS * 2 ** (attempt - 1);
                console.warn(`Gemini call failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}. Retrying in ${wait}ms...`);
                await sleep(wait);
            } else if (!isRetryable) {
                // Non-retryable error (like 400 Bad Request) - fail fast
                break;
            }
        }
    }

    // All Gemini retries exhausted - try Groq fallback
    if (groqClient) {
        console.warn('Gemini failed after all retries. Falling back to Groq...');
        try {
            const groqTools = geminiTools.map(tool => {
                // Convert Gemini function declaration to Groq/OpenAI format
                return {
                    type: 'function',
                    function: tool,
                };
            });
            return await callGroq(contents, groqTools);
        } catch (groqError) {
            console.error(`Groq fallback also failed: ${groqError.message}`);
            throw new Error(`Both Gemini and Groq failed. Gemini: ${lastError.message}. Groq: ${groqError.message}`);
        }
    }

    throw lastError;
}

/**
 * Hands Gemini a list of already-scored postings and lets Gemini decide
 * whether to call send_digest_alert — no shouldTriggerTool() filter, no
 * manual handleToolCall(). This is the real "agent decides the tool call"
 * flow, running over the actual MCP protocol.
 *
 * @param {Array} scoredPostings - postings with fit_score/fit_reasoning already set
 * @param {number} fitScoreThreshold - minimum fit score to trigger notification (0-100)
 */
export async function notifyViaMcp(scoredPostings, fitScoreThreshold = DEFAULT_FIT_SCORE_THRESHOLD) {
    if (scoredPostings.length === 0) {
        console.log('No scored postings to hand to the agent — skipping.');
        return;
    }

    // 1. Launch the real MCP server as a subprocess and connect to it.
    // CRITICAL: Must pass env vars (DATABASE_URL, DISCORD_WEBHOOK_URL, etc.)
    // to the subprocess, otherwise mcp-server.mjs can't connect to the database.
    const transport = new StdioClientTransport({
        command: 'node',
        args: [path.join(__dirname, 'mcp-server.mjs')],
        env: process.env,
    });
    const mcpClient = new Client({ name: 'pfe-hunter-gemini-client', version: '1.0.0' });
    await mcpClient.connect(transport);

    try {
        // 2. Discover the tool(s) the server exposes — nothing hardcoded
        //    on this side.
        const { tools } = await mcpClient.listTools();
        const geminiTools = tools.map(mcpToolToGeminiDeclaration);

        // 3. Ask Gemini to decide. The threshold is given as an
        //    instruction in the prompt, not enforced by our own code —
        //    Gemini is the one applying it.
        const prompt =
            `Here are today's scored job postings (fit_score is 0-100):\n\n` +
            JSON.stringify(scoredPostings, null, 2) +
            `\n\nIf any posting has fit_score >= ${fitScoreThreshold}, call send_digest_alert ` +
            `ONCE with all qualifying postings batched together. If none qualify, don't call anything.`;

        const contents = [{ role: 'user', parts: [{ text: prompt }] }];
        const response = await callGemini(contents, geminiTools);

        const parts = response.candidates?.[0]?.content?.parts ?? [];
        const functionCallPart = parts.find((p) => p.functionCall);

        if (!functionCallPart) {
            console.log('Gemini decided not to call any tool — no qualifying postings.');
            return;
        }

        const { name, args } = functionCallPart.functionCall;
        console.log(`Gemini requested MCP tool: ${name}`);

        // 4. Execute the call through the real MCP protocol — this is
        //    the actual network hop from "Gemini wants to do this" to
        //    "the server actually did it".
        const result = await mcpClient.callTool({ name, arguments: args });

        // Log the FULL result — the old version printed only
        // content[0].text and never checked isError, so tool failures
        // (validation errors, Discord send failures) looked like success.
        console.log('MCP tool result:', JSON.stringify(result, null, 2));

        if (result.isError) {
            const errorText =
                result.content?.map((c) => c.text ?? '').join('\n') || JSON.stringify(result);
            throw new Error(`MCP tool "${name}" failed: ${errorText}`);
        }
    } finally {
        await mcpClient.close();
    }
}
