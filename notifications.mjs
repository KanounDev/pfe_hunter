// notifications.mjs
//
// The actual "send a digest somewhere" logic for the MCP Tool Layer.
// Supports Telegram and/or Discord, both free/no-card per the architecture
// doc. If neither is configured, falls back to a DRY RUN that just prints
// the exact payload that would have been sent — this is what lets you
// verify the tool layer end-to-end before you've created a bot/webhook.
//
// ENV VARS (all optional — configure whichever channel(s) you want):
//   TELEGRAM_BOT_TOKEN   - from @BotFather
//   TELEGRAM_CHAT_ID     - the chat/user id the bot should message
//   DISCORD_WEBHOOK_URL  - a channel webhook URL from Discord "Integrations"

import 'dotenv/config';

/**
 * Turn a list of scored postings into the digest text the user actually
 * reads. Kept as its own function so the test harness can assert on the
 * *shape* of the payload without needing real network creds.
 */
export function formatDigest(postings) {
    const lines = postings.map((p) => {
        const score = p.fit_score != null ? `${p.fit_score}/100` : 'unscored';
        const reasoning = p.fit_reasoning ? `\n  Why: ${p.fit_reasoning}` : '';
        return `• [${score}] ${p.title} @ ${p.company} — ${p.location}\n  ${p.job_url}${reasoning}`;
    });

    return `PFE Hunter — ${postings.length} new match(es)\n\n${lines.join('\n\n')}`;
}

async function sendTelegramMessage(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return null;

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });

    if (!res.ok) {
        throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
    }
    return { channel: 'telegram', ok: true };
}

async function sendDiscordMessage(text) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return null;

    const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Discord messages cap at 2000 chars; truncate defensively.
        body: JSON.stringify({ content: text.slice(0, 1990) }),
    });

    if (!res.ok) {
        throw new Error(`Discord send failed: ${res.status} ${await res.text()}`);
    }
    return { channel: 'discord', ok: true };
}

/**
 * Sends the digest to every configured channel. If nothing is configured,
 * returns a dryRun result instead of throwing — this is the "verify the
 * payload end-to-end" path for local testing.
 *
 * @param {Array} postings - postings with fit_score >= threshold
 * @returns {Promise<{dryRun: boolean, text: string, results: Array}>}
 */
export async function sendDigestAlert(postings) {
    const text = formatDigest(postings);
    const attempts = await Promise.all([
        sendTelegramMessage(text).catch((err) => ({ channel: 'telegram', ok: false, error: err.message })),
        sendDiscordMessage(text).catch((err) => ({ channel: 'discord', ok: false, error: err.message })),
    ]);

    const results = attempts.filter(Boolean);

    if (results.length === 0) {
        return { dryRun: true, text, results: [] };
    }

    return { dryRun: false, text, results };
}

/**
 * A second, deliberately distinct kind of alert from sendDigestAlert(): a
 * job-match digest tells you the pipeline is working and found something
 * good; this tells you the pipeline itself broke (any step — scrape,
 * dedup, scoring, MCP tool call). Before this, a failed run just died
 * silently with nothing but a console error, easy to miss on an
 * unattended 6-hourly schedule. Reuses the same configured Telegram/Discord
 * channels but with a clearly different "pipeline failure" prefix so the
 * two alert types are never confused when read on the phone.
 *
 * Wire this into the top-level catch of whatever runs the pipeline end to
 * end — see test-pfe-hunter-dedup.mjs's main().catch() for the pattern to
 * copy into a real scheduled runner later.
 *
 * @param {string} step - which stage failed, e.g. "dedup", "scoring", "mcp-notify"
 * @param {Error} error
 */
export async function sendPipelineFailureAlert(step, error) {
    const text = `🚨 PFE Hunter pipeline failure\nStep: ${step}\nError: ${error.message}`;

    const attempts = await Promise.all([
        sendTelegramMessage(text).catch((err) => ({ channel: 'telegram', ok: false, error: err.message })),
        sendDiscordMessage(text).catch((err) => ({ channel: 'discord', ok: false, error: err.message })),
    ]);

    const results = attempts.filter(Boolean);

    if (results.length === 0) {
        console.error(`[pipeline failure alert — dry run, no channel configured]\n${text}`);
    }

    return results;
}
