/**
 * api/accept.js
 * Evaluator taps "Accept — [Name]" in Google Chat → opens this URL (GET).
 *
 * Flow:
 * 1. Create a Meet space via Meet API with accessType: OPEN (anyone joins instantly, no host gate)
 * 2. Create a calendar event on automations@goforko.com referencing that space so Otter detects it
 * 3. Mark session as accepted in KV, store the Meet link
 * 4. Notify team via Google Chat
 * 5. Redirect evaluator to the new Meet room
 */

import { kv } from '@vercel/kv';

const EVALUATORS = ['Ricky', 'Hunter', 'Nate'];
const CALENDAR_ID = 'automations@goforko.com';
const FALLBACK_MEET = 'https://meet.google.com/vnz-jgvp-ywe';

export default async function handler(req, res) {
    const { session, name } = req.query;

    if (!session || !name) return res.status(400).send('Missing session or name.');
    if (!EVALUATORS.includes(name)) return res.status(400).send('Unknown evaluator name.');

    let meetLink = FALLBACK_MEET;

    try {
        const key = `session:${session}`;
        const data = await kv.get(key);

        if (data && data.accepted) {
            const existingRoom = data.meetLink || FALLBACK_MEET;
            res.setHeader('Content-Type', 'text/html');
            return res.status(200).send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
                <h2>✅ Already claimed</h2>
                <p>Accepted by <strong>${data.acceptedBy}</strong>.</p>
                <p><a href="${existingRoom}" style="color:#bd1e2e">Join Meet anyway →</a></p>
            </body></html>`);
        }

        // Operation log for /api/debug
        const opLog = { ts: new Date().toISOString(), evaluator: name, steps: {} };

        const accessToken = await getAccessToken();
        opLog.steps.token = accessToken ? '✅ obtained' : '❌ failed — re-auth at /api/auth';

        if (accessToken) {
            // Step 1: Create Meet space with OPEN access (no host required)
            const { meetingUri, meetingCode, spaceName, error: spaceError } = await createOpenMeetSpace(accessToken);
            opLog.steps.meetSpace = meetingUri
                ? `✅ created OPEN space → ${meetingUri}`
                : `❌ failed — ${spaceError || 'unknown'}`;

            if (meetingUri) {
                meetLink = meetingUri;
                opLog.meetLink = meetingUri;

                // Step 2: Create calendar event referencing the new space so Otter detects it
                const { error: calError } = await createCalendarEvent(accessToken, name, meetingUri, meetingCode);
                opLog.steps.calendarEvent = calError
                    ? `❌ failed — ${calError}`
                    : `✅ created on ${CALENDAR_ID}`;
            }
        }

        // Store op log for /api/debug (expires 2 hrs)
        await kv.set('debug:last-accept', opLog, { ex: 7200 }).catch(() => { });

        // Mark session as accepted
        await kv.set(key, {
            ...(data || {}),
            accepted: true,
            acceptedBy: name,
            meetLink,
        }, { ex: 3600 });

        // Notify team via Google Chat
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

    res.writeHead(302, { Location: meetLink });
    res.end();
}

/** Gets a fresh access token from the stored refresh token */
async function getAccessToken() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) { console.warn('Google creds not set'); return null; }

    const refreshToken = await kv.get('google:calendar:refresh_token');
    if (!refreshToken) { console.warn('No refresh token — visit /api/auth'); return null; }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId, client_secret: clientSecret,
            refresh_token: refreshToken, grant_type: 'refresh_token',
        }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) { console.error('Token refresh failed:', tokenData); return null; }
    return tokenData.access_token;
}

/**
 * Creates a Google Meet space with accessType: OPEN via the Meet Spaces API.
 * OPEN = anyone with the link joins instantly, no host admission required.
 * Returns { meetingUri, meetingCode, spaceName } or { error } on failure.
 */
async function createOpenMeetSpace(accessToken) {
    const res = await fetch('https://meet.googleapis.com/v2/spaces', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { accessType: 'OPEN' } }),
    });

    if (!res.ok) {
        const errText = await res.text();
        console.error('Meet Spaces API error:', errText);
        return { error: errText };
    }

    const space = await res.json();
    console.log('Meet space created:', JSON.stringify(space));

    const meetingUri = space.meetingUri;
    const meetingCode = space.meetingCode;
    const spaceName = space.name; // e.g. "spaces/jQCFfuBOdN5z"

    return { meetingUri, meetingCode, spaceName };
}

/**
 * Creates a calendar event on automations@goforko.com referencing the existing Meet space.
 * Using the Meet space's URI in conferenceData so Otter's OtterPilot can detect and join.
 */
async function createCalendarEvent(accessToken, evaluatorName, meetingUri, meetingCode) {
    const now = new Date();
    const start = new Date(now.getTime() + 3 * 60 * 1000);  // 3 min out — gives Otter time to detect & join
    const end = new Date(now.getTime() + 33 * 60 * 1000);

    const event = {
        summary: `KO Evaluation — ${evaluatorName}`,
        description: `Live evaluation call accepted by ${evaluatorName}. Auto-recorded via Otter.\n\nJoin: ${meetingUri}`,
        start: { dateTime: start.toISOString(), timeZone: 'America/Chicago' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Chicago' },
        location: meetingUri,
        conferenceData: {
            conferenceId: meetingCode,
            conferenceSolution: {
                key: { type: 'hangoutsMeet' },
                name: 'Google Meet',
                iconUri: 'https://fonts.gstatic.com/s/i/productlogos/meet_2020q4/v1/web-512dp/logo_meet_2020q4_color_2x_web_512dp.png',
            },
            entryPoints: [{
                entryPointType: 'video',
                uri: meetingUri,
                label: 'Join Google Meet',
            }],
        },
    };

    const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?sendUpdates=none`,
        {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
        }
    );

    if (!calRes.ok) {
        const errText = await calRes.text();
        console.error('Calendar API error:', errText);
        return { error: errText };
    }

    const created = await calRes.json();
    console.log('Calendar event created, hangoutLink:', created.hangoutLink || 'not set');
    return { hangoutLink: created.hangoutLink };
}
