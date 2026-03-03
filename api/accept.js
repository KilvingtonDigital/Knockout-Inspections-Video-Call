/**
 * api/accept.js
 * Inspector taps "Accept — [Name]" in Google Chat → opens this URL (GET).
 * 1. Marks session as accepted in Upstash Redis
 * 2. Sends "✅ [Name] has accepted" to Google Chat
 * 3. Redirects inspector's browser directly into Google Meet
 */

import { kv } from '@vercel/kv';

const MEET_LINK = 'https://meet.google.com/vnz-jgvp-ywe';
const INSPECTORS = ['Ricky', 'Hunter', 'Nate'];

export default async function handler(req, res) {
    const { session, name } = req.query;

    if (!session || !name) {
        return res.status(400).send('Missing session or name parameter.');
    }

    // Validate inspector name (prevent spoofing)
    if (!INSPECTORS.includes(name)) {
        return res.status(400).send('Unknown inspector name.');
    }

    try {
        const key = `session:${session}`;
        const data = await kv.get(key);

        // If already claimed by someone else, let them know and still redirect to Meet
        if (data && data.accepted) {
            const msg = `<html><body style="font-family:sans-serif;text-align:center;padding:40px">
                <h2>✅ Already claimed</h2>
                <p>This call was accepted by <strong>${data.acceptedBy}</strong>.</p>
                <p><a href="${MEET_LINK}" style="color:#bd1e2e">Join Meet anyway →</a></p>
            </body></html>`;
            res.setHeader('Content-Type', 'text/html');
            return res.status(200).send(msg);
        }

        // Mark as accepted — preserve existing GPS fields
        await kv.set(key, {
            ...(data || {}),
            accepted: true,
            acceptedBy: name
        }, { ex: 3600 });

        // Notify the team
        const webhookUrl = process.env.CHAT_WEBHOOK_URL;
        if (webhookUrl) {
            const payload = {
                text: `✅ *${name} has accepted this evaluation call* — no action needed from others.\nThey're joining Meet now.`
            };
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => { });
        }

    } catch (err) {
        console.error('Accept error:', err);
        // Non-fatal — still redirect to Meet even if Redis is down
    }

    // Send inspector straight into the call
    res.writeHead(302, { Location: MEET_LINK });
    res.end();
}
