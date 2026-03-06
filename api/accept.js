/**
 * api/accept.js
 * Evaluator taps "Accept — [Name]" in Google Chat → opens this URL (GET).
 * 1. Creates a fresh Google Meet space via Meet Spaces API (accessType: OPEN — no host required)
 * 2. Creates a calendar event on automations@goforko.com linking to that space (Otter detects it)
 * 3. Marks session as accepted in Upstash Redis, stores the new Meet link
 * 4. Sends "✅ [Name] has accepted" to Google Chat
 * 5. Redirects evaluator directly into the new Meet room
 */

import { kv } from '@vercel/kv';

const EVALUATORS = ['Ricky', 'Hunter', 'Nate'];
const CALENDAR_ID = 'automations@goforko.com';
const FALLBACK_MEET = 'https://meet.google.com/vnz-jgvp-ywe';

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

        // Get a fresh OAuth access token
        const accessToken = await getAccessToken();

        if (accessToken) {
            // 1. Create a Meet space with OPEN access (no host required to admit participants)
            const spaceUri = await createMeetSpace(accessToken);
            if (spaceUri) meetLink = spaceUri;

            // 2. Create a calendar event linking to the space so Otter auto-joins
            await createCalendarEvent(accessToken, name, meetLink).catch((err) => {
                console.warn('Calendar event creation failed (non-fatal):', err.message);
            });
        }

        // 3. Mark session as accepted and store the Meet link
        await kv.set(key, {
            ...(data || {}),
            accepted: true,
            acceptedBy: name,
            meetLink,
        }, { ex: 3600 });

        // 4. Notify the team via Google Chat
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
    }

    // 5. Send evaluator into their Meet room
    res.writeHead(302, { Location: meetLink });
    res.end();
}

/** Gets a fresh access token using the stored refresh token */
async function getAccessToken() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.warn('Google credentials not set');
        return null;
    }

    const refreshToken = await kv.get('google:calendar:refresh_token');
    if (!refreshToken) {
        console.warn('No refresh token in KV — visit /api/auth to authorize');
        return null;
    }

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

    return tokenData.access_token;
}

/**
 * Creates a new Google Meet space with accessType OPEN.
 * OPEN = anyone with the link can join immediately, no host admission needed.
 * Returns the meetingUri (e.g. https://meet.google.com/abc-defg-hij) or null.
 */
async function createMeetSpace(accessToken) {
    const res = await fetch('https://meet.googleapis.com/v2/spaces', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            config: {
                accessType: 'OPEN',  // No host required — anyone with link joins instantly
            }
        }),
    });

    if (!res.ok) {
        console.error('Meet Spaces API error:', await res.text());
        return null;
    }

    const space = await res.json();
    const uri = space.meetingUri;
    console.log('Created Meet space:', uri);
    return uri || null;
}

/**
 * Creates a calendar event on automations@goforko.com with the Meet link
 * as a conference entry point so Otter's OtterPilot detects and joins the call.
 */
async function createCalendarEvent(accessToken, evaluatorName, meetUri) {
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 60 * 1000);

    // Extract the Meet room code from the URI for the conference ID
    const roomCode = meetUri.split('/').pop(); // e.g. "abc-defg-hij"

    const event = {
        summary: `KO Evaluation — ${evaluatorName}`,
        description: `Live evaluation call accepted by ${evaluatorName}. Auto-recorded via Otter.\n\nJoin: ${meetUri}`,
        start: { dateTime: now.toISOString(), timeZone: 'America/Chicago' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Chicago' },
        location: meetUri,
        conferenceData: {
            conferenceId: roomCode,
            conferenceSolution: {
                name: 'Google Meet',
                key: { type: 'hangoutsMeet' },
                iconUri: 'https://fonts.gstatic.com/s/i/productlogos/meet_2020q4/v1/web-512dp/logo_meet_2020q4_color_2x_web_512dp.png',
            },
            entryPoints: [{
                entryPointType: 'video',
                uri: meetUri,
                label: 'Join Google Meet',
            }],
        },
    };

    const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?sendUpdates=none`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(event),
        }
    );

    if (!calRes.ok) {
        throw new Error(`Calendar API error: ${await calRes.text()}`);
    }

    console.log(`Calendar event created for ${evaluatorName} linking to ${meetUri}`);
}
