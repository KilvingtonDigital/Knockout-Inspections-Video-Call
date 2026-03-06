/**
 * api/accept.js
 * Evaluator taps "Accept — [Name]" in Google Chat → opens this URL (GET).
 * Flow:
 * 1. Creates a calendar event with conferenceData.createRequest (Google auto-assigns a Meet room)
 *    → This gives the event a proper `hangoutLink` that Otter's OtterPilot detects
 * 2. Immediately patches the new Meet space to accessType: OPEN (no host required to admit people)
 * 3. Marks session as accepted in Upstash Redis, stores the Meet link
 * 4. Notifies the team via Google Chat
 * 5. Redirects evaluator to the new Meet room
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

        const accessToken = await getAccessToken();

        if (accessToken) {
            // Step 1: Create calendar event with conferenceData.createRequest
            // Google auto-creates a Meet room and sets hangoutLink on the event → Otter detects this
            const { hangoutLink, spaceName } = await createCalendarEventWithMeet(accessToken, name);

            if (hangoutLink) {
                meetLink = hangoutLink;

                // Step 2: Patch the Meet space to OPEN so anyone with the link can join (no host required)
                if (spaceName) {
                    await patchSpaceToOpen(accessToken, spaceName).catch((err) => {
                        console.warn('Space patch failed (non-fatal — room still works):', err.message);
                    });
                }
            }
        }

        // Step 3: Mark session as accepted
        await kv.set(key, {
            ...(data || {}),
            accepted: true,
            acceptedBy: name,
            meetLink,
        }, { ex: 3600 });

        // Step 4: Notify team via Google Chat
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

    // Step 5: Redirect evaluator to the Meet room
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
 * Creates a 30-min calendar event with conferenceData.createRequest.
 * Google assigns a new Meet room and attaches a proper hangoutLink to the event.
 * Otter's OtterPilot reads hangoutLink to detect and join the meeting.
 * Returns { hangoutLink, spaceName } or empty object on failure.
 */
async function createCalendarEventWithMeet(accessToken, evaluatorName) {
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 60 * 1000);
    const reqId = `ko-eval-${Date.now()}`;

    const event = {
        summary: `KO Evaluation — ${evaluatorName}`,
        description: `Live evaluation call accepted by ${evaluatorName}. Auto-recorded via Otter.`,
        start: { dateTime: now.toISOString(), timeZone: 'America/Chicago' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Chicago' },
        conferenceData: {
            createRequest: {
                requestId: reqId,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
            }
        },
    };

    // conferenceDataVersion=1 is required for createRequest to take effect
    const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?conferenceDataVersion=1&sendUpdates=none`,
        {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
        }
    );

    if (!calRes.ok) {
        const errText = await calRes.text();
        console.error('Calendar API error:', errText);
        return {};
    }

    const created = await calRes.json();
    const hangoutLink = created.hangoutLink;                          // e.g. https://meet.google.com/abc-defg-hij
    const confId = created.conferenceData?.conferenceId;         // e.g. "abc-defg-hij"
    const spaceName = confId ? `spaces/${confId}` : null; // Keep dashes: spaces/abc-defg-hij

    console.log(`Calendar event created → hangoutLink: ${hangoutLink}, spaceName: ${spaceName}`);
    return { hangoutLink: hangoutLink || null, spaceName };
}

/**
 * Updates the Meet space to accessType: OPEN.
 * OPEN = anyone with the link joins instantly, no host admission required.
 */
async function patchSpaceToOpen(accessToken, spaceName) {
    const res = await fetch(`https://meet.googleapis.com/v2/${spaceName}?updateMask=config.accessType`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { accessType: 'OPEN' } }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
    }
    console.log(`Meet space ${spaceName} patched to OPEN ✅`);
}
