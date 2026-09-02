// test-gemini-declaration.mjs — verifies that the tool declaration Gemini
// actually receives is accepted by the API. Catches 400s like
// "Proto field is not repeating, cannot start list" BEFORE a pipeline run.
//
//   node test-gemini-declaration.mjs
//
// 1. Connects to mcp-server.mjs and captures the RAW zod → JSON Schema
// 2. Runs it through sanitizeSchemaForGemini (same code as the pipeline)
// 3. Makes one real Gemini generateContent call with the declaration
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpToolToGeminiDeclaration } from './gemini-mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, 'mcp-server.mjs')],
});
const client = new Client({ name: 'declaration-test', version: '1.0.0' });
await client.connect(transport);

try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'send_digest_alert');
    if (!tool) throw new Error('send_digest_alert not found on the MCP server');

    console.log('=== RAW MCP inputSchema (zod → JSON Schema) ===');
    console.log(JSON.stringify(tool.inputSchema, null, 2));

    const declaration = mcpToolToGeminiDeclaration(tool);
    console.log('\n=== SANITIZED Gemini declaration ===');
    console.log(JSON.stringify(declaration, null, 2));

    const raw = JSON.stringify(declaration);
    const issues = [];
    if (raw.includes('"anyOf"')) issues.push('anyOf still present');
    if (/"type":\s*\[/.test(raw)) issues.push('type array still present');
    console.log(issues.length ? `\n❌ ISSUES: ${issues.join(', ')}` : '\n✅ no anyOf / type-arrays remain in the declaration');

    // The real test: one tiny generateContent call carrying the declaration.
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'Do not call any tool. Reply with the word OK.' }] }],
                tools: [{ functionDeclarations: [declaration] }],
            }),
        }
    );

    console.log('\n=== Gemini API response ===');
    console.log('status:', res.status);
    const body = await res.json();
    if (!res.ok) {
        console.log(JSON.stringify(body, null, 2));
        process.exitCode = 1;
    } else {
        const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        console.log('model replied:', JSON.stringify(text.trim()));
        console.log('✅ tool declaration accepted by Gemini');
    }
} finally {
    await client.close();
}