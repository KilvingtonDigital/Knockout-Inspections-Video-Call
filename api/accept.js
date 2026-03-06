/**
 * api/accept.js
 * Evaluator taps "Accept — [Name]" in Google Chat → opens this URL (GET).
 * 1. Marks session as accepted in Upstash Redis
 * 2. Sends "✅ [Name] has accepted" to Google Chat
 * 3. Creates a 30-min Google Calendar event with the Meet link → Otter auto-joins
 * 4. Redirects evaluator's browser directly into Google Meet
 */

import { kv } from '@vercel/kv';

const MEET_LINK = 'https://meet.google.com/vnz-jgvp-ywe';
const INSPECTORS = ['Ricky', 'Hunter', 'Nate'];
const CALENDAR_ID = 'automations@goforko.com'; // Dedicated automation account calendar

export default async function handler(req, res) {
    const { session, name } = req.query;

    if (!session || !name) {
        return res.status(400).send('Missing session or name parameter.');
    }

    // Validate evaluator name (prevent spoofing)
    if (!INSPECTORS.includes(name)) {
        return res.status(400).send('Unknown evaluator name.');
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

        // Notify the team via Google Chat
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

        // Create a 30-min Google Calendar event so Otter auto-joins this specific call
        await createCalendarEvent(req, name).catch((err) => {
            console.warn('Calendar event creation failed (non-fatal):', err.message);
        });

    } catch (err) {
        console.error('Accept error:', err);
        // Non-fatal — still redirect to Meet even if KV/Calendar is down
    }

    // Send evaluator straight into the call
    res.writeHead(302, { Location: MEET_LINK });
    res.end();
}

/**
 * Creates a 30-minute Google Calendar event with the Meet link.
 * Otter's OtterPilot detects this and auto-joins within ~60 seconds.
 */
async function createCalendarEvent(req, evaluatorName) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — skipping calendar event');
        return;
    }

    // Get stored refresh token from KV
    const refreshToken = await kv.get('google:calendar:refresh_token');
    if (!refreshToken) {
        console.warn('No Google refresh token in KV. Visit /api/auth to authorize.');
        return;
    }

    // Exchange refresh token for a fresh access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
        throw new Error(`Token refresh failed: ${JSON.stringify(tokenData)}`);
    }

    // Build event — starts 1 min from now (gives Otter time to process the invite)
    const now = new Date();
    const start = new Date(now.getTime() + 1 * 60 * 1000);
    const end = new Date(now.getTime() + 31 * 60 * 1000);

    const event = {
        summary: `KO Evaluation — ${evaluatorName}`,
        description: `Live evaluation call accepted by ${evaluatorName}.\n\nJoin here: ${MEET_LINK}`,
        start: { dateTime: start.toISOString(), timeZone: 'America/Chicago' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Chicago' },
        location: MEET_LINK,
        attendees: [
            { email: 'automations@goforko.com' },
            { email: 'notetaker@otter.ai' }
        ],
    };

    const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?sendUpdates=externalOnly`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(event),
        }
    );

    if (!calRes.ok) {
        const err = await calRes.text();
        throw new Error(`Calendar API error: ${err}`);
    }

    console.log(`Calendar event created for ${evaluatorName}'s evaluation call.`);
}
