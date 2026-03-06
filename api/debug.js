/**
 * api/debug.js
 * Returns a human-readable diagnostic page showing:
 * - Auth token status
 * - Last accept operation log (from KV)
 * - Upstash KV connectivity
 *
 * Visit: https://knockout-inspections-video-call.vercel.app/api/debug
 */

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'text/html');

    const results = {};

    // 1. Check env vars
    results.env = {
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? '✅ set' : '❌ missing',
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? '✅ set' : '❌ missing',
        CHAT_WEBHOOK_URL: process.env.CHAT_WEBHOOK_URL ? '✅ set' : '❌ missing',
        KV_REST_API_URL: process.env.KV_REST_API_URL ? '✅ set' : '❌ missing',
        FIREFLIES_API_KEY: process.env.FIREFLIES_API_KEY ? '✅ set' : '❌ missing',
    };

    // 2. Check KV connectivity + refresh token
    try {
        const token = await kv.get('google:calendar:refresh_token');
        results.kv = token ? '✅ connected — refresh token present' : '⚠️ connected — NO refresh token (visit /api/auth)';
    } catch (err) {
        results.kv = `❌ KV error: ${err.message}`;
    }

    // 3. Last accept operation log
    try {
        const opLog = await kv.get('debug:last-accept');
        results.lastAccept = opLog || '⚠️ No accept operation logged yet — trigger a call first';
    } catch (err) {
        results.lastAccept = `❌ Could not read log: ${err.message}`;
    }

    // Render HTML
    const section = (title, content) => `
        <div style="margin-bottom:28px">
            <h2 style="font-size:1rem;font-weight:700;color:#292458;margin-bottom:10px;border-bottom:2px solid #e2e8f0;padding-bottom:6px">${title}</h2>
            <pre style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;font-size:0.82rem;overflow:auto;white-space:pre-wrap">${content}</pre>
        </div>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>KO Inspections — Debug</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #f1f5f9; margin: 0; padding: 32px 16px; }
        .wrap { max-width: 720px; margin: 0 auto; background: white; border-radius: 16px; padding: 32px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
        h1 { font-size: 1.3rem; color: #bd1e2e; margin-bottom: 24px; }
    </style>
</head>
<body>
<div class="wrap">
    <h1>🔍 KO Inspections — Debug Dashboard</h1>
    <p style="color:#64748b;font-size:.85rem;margin-bottom:24px">Last updated: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT</p>

    ${section('Environment Variables', JSON.stringify(results.env, null, 2))}
    ${section('Upstash KV + OAuth Token', results.kv)}
    ${section('Last Accept Operation Log', typeof results.lastAccept === 'object'
        ? JSON.stringify(results.lastAccept, null, 2)
        : results.lastAccept)}

    <p style="text-align:center;margin-top:24px">
        <a href="/api/auth" style="color:#bd1e2e;font-size:.85rem">Re-authorize Google Calendar/Meet →</a>
    </p>
</div>
</body>
</html>`;

    res.status(200).send(html);
}
