/**
 * api/accept.js
 * Evaluator taps "Accept — [Name]" in Google Chat → opens this URL (GET).
 * 1. Creates a fresh Google Meet room via Calendar API (new room per call)
 * 2. Marks session as accepted in Upstash Redis, stores the new Meet link
 * 3. Sends "✅ [Name] has accepted" to Google Chat
 * 4. Redirects evaluator directly into the new Meet room
 *
 * The new Meet link is stored in KV so /api/status can return it
 * and the customer's browser redirects to the same room.
 */

import { kv } from '@vercel/kv';

const EVALUATORS = ['Ricky', 'Hunter', 'Nate'];
const CALENDAR_ID = 'automations@goforko.com'; // Dedicated automation account — Otter watches this calendar
const FALLBACK_MEET = 'https://meet.google.com/vnz-jgvp-ywe'; // used if Calendar API fails

export default async function handler(req, res) {
    const { session, name } = req.query;

    if (!session || !name) {
        return res.status(400).send('Missing session or name parameter.');
    }

    if (!EVALUATORS.includes(name)) {
        return res.status(400).send('Unknown evaluator name.');
    }

    let meetLink = FALLBACK_MEET;

    try {
        const key = `session:${session}`;
        const data = await kv.get(key);

        // Already claimed — show info and link to that room
        if (data && data.accepted) {
            const existingRoom = data.meetLink || FALLBACK_MEET;
            const msg = `<html><body style="font-family:sans-serif;text-align:center;padding:40px">
                <h2>✅ Already claimed</h2>
                <p>This call was accepted by <strong>${data.acceptedBy}</strong>.</p>
                <p><a href="${existingRoom}" style="color:#bd1e2e">Join Meet anyway →</a></p>
            </body></html>`;
            res.setHeader('Content-Type', 'text/html');
            return res.status(200).send(msg);
        }

        // Create a fresh Meet room via Calendar API
        const newRoom = await createMeetRoom(name);
        if (newRoom) meetLink = newRoom;

        // Mark session as accepted and store the Meet link
        await kv.set(key, {
            ...(data || {}),
            accepted: true,
            acceptedBy: name,
            meetLink,
        }, { ex: 3600 });

        // Notify the team via Google Chat
        const webhookUrl = process.env.CHAT_WEBHOOK_URL;
        if (webhookUrl) {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: `✅ *${name} has accepted this evaluation call* — no action needed from others.\nThey're joining Meet now.`
                })
            }).catch(() => { });
        }

    } catch (err) {
        console.error('Accept error:', err);
        // Non-fatal — still redirect to fallback Meet room
    }

    // Send evaluator into their fresh Meet room
    res.writeHead(302, { Location: meetLink });
    res.end();
}

/**
 * Creates a new Google Meet room via Calendar API (conferenceData.createRequest).
 * Returns the hangoutLink (e.g. https://meet.google.com/abc-defg-hij) or null on failure.
 */
async function createMeetRoom(evaluatorName) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.warn('Google credentials not set — using fallback Meet room');
        return null;
    }

    const refreshToken = await kv.get('google:calendar:refresh_token');
    if (!refreshToken) {
        console.warn('No refresh token in KV — visit /api/auth to authorize');
        return null;
    }

    // Get a fresh access token
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
        console.error('Token refresh failed:', tokenData);
        return null;
    }

    // Build a 30-min event starting now with a brand-new Meet room
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 60 * 1000);

    const event = {
        summary: `KO Evaluation — ${evaluatorName}`,
        description: `Live evaluation call accepted by ${evaluatorName}. Auto-recorded via Otter.`,
        start: { dateTime: now.toISOString(), timeZone: 'America/Chicago' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Chicago' },
        conferenceData: {
            createRequest: {
                requestId: `ko-eval-${Date.now()}`,  // must be unique per request
                conferenceSolutionKey: { type: 'hangoutsMeet' },
            }
        },
    };

    // conferenceDataVersion=1 is required for conferenceData.createRequest to work
    const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?conferenceDataVersion=1&sendUpdates=none`,
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
        const errText = await calRes.text();
        console.error('Calendar API error:', errText);
        return null;
    }

    const created = await calRes.json();
    const hangoutLink = created.hangoutLink || created.conferenceData?.entryPoints?.[0]?.uri;

    if (hangoutLink) {
        console.log(`New Meet room created for ${evaluatorName}: ${hangoutLink}`);
    } else {
        console.warn('Calendar event created but no hangoutLink returned:', JSON.stringify(created));
    }

    return hangoutLink || null;
}
