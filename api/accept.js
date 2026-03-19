/**
 * api/accept.js
 * Evaluator taps "Accept — [Name]" in Google Chat → opens this URL (GET).
 *
 * Flow:
 * 1. Create a Meet space via Meet API with accessType: OPEN (anyone joins instantly, no host gate)
 * 2. Trigger Fireflies bot to join the Meet room (via Fireflies GraphQL API) — bot joins in ~30s
 * 3. Mark session as accepted in KV, store the Meet link
 * 4. Notify team via Google Chat
 * 5. Redirect evaluator to the new Meet room
 */

import { kv } from '@vercel/kv';

const EVALUATORS = ['Ricky', 'Hunter', 'Nate', 'Erica'];

export default async function handler(req, res) {
    const { session, name } = req.query;

    if (!session || !name) return res.status(400).send('Missing session or name.');
    if (!EVALUATORS.includes(name)) return res.status(400).send('Unknown evaluator name.');

    let meetLink = null;

    try {
        const key = `session:${session}`;
        const data = await kv.get(key);

        if (data && data.accepted) {
            const existingRoom = data.meetLink;
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
            // Step 1: Create Meet space with OPEN access (no host gate)
            const { meetingUri, error: spaceError } = await createOpenMeetSpace(accessToken);
            opLog.steps.meetSpace = meetingUri
                ? `✅ created OPEN space → ${meetingUri}`
                : `❌ failed — ${spaceError || 'unknown'}`;

            if (meetingUri) {
                meetLink = meetingUri;
                opLog.meetLink = meetingUri;

                // Step 2: Trigger Fireflies bot — skip for internal staff calls
                if (data?.isInternal) {
                    opLog.steps.fireflies = '⏭️ skipped — internal staff call';
                } else {
                    const { error: ffError } = await triggerFirefliesBot(meetingUri, name, session);
                    opLog.steps.fireflies = ffError
                        ? `❌ failed — ${ffError}`
                        : '✅ bot dispatched — joins in ~30s';
                }
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

/** Gets a cached access token, or refreshes if needed */
async function getAccessToken() {
    const cachedToken = await kv.get('google:calendar:access_token');
    if (cachedToken) return cachedToken;

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
    
    // Cache the access token for 50 minutes (Google tokens expire in 60 mins)
    await kv.set('google:calendar:access_token', tokenData.access_token, { ex: 3000 });
    
    return tokenData.access_token;
}

/**
 * Creates a Google Meet space with accessType: OPEN via the Meet Spaces API.
 * Returns { meetingUri } or { error }.
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
    console.log('Meet space created:', space.meetingUri);
    return { meetingUri: space.meetingUri, meetingCode: space.meetingCode, spaceName: space.name };
}

/**
 * Triggers the Fireflies notetaker bot to join a Google Meet room.
 * Uses the Fireflies GraphQL API — bot joins within ~30 seconds.
 * Returns { error } on failure or {} on success.
 */
async function triggerFirefliesBot(meetingUri, evaluatorName, sessionId) {
    const apiKey = process.env.FIREFLIES_API_KEY;
    if (!apiKey) {
        console.warn('FIREFLIES_API_KEY not set — skipping bot dispatch');
        return { error: 'FIREFLIES_API_KEY not set in Vercel env vars' };
    }

    const mutation = `
        mutation AddToLiveMeeting($meeting_link: String!, $title: String) {
            addToLiveMeeting(
                meeting_link: $meeting_link,
                title: $title
            ) {
                __typename
            }
        }
    `;

    const variables = {
        meeting_link: meetingUri,
        title: `KO Evaluation — ${evaluatorName}`,
    };

    const res = await fetch('https://api.fireflies.ai/graphql', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: mutation, variables }),
    });

    if (!res.ok) {
        const errText = await res.text();
        console.error('Fireflies API error:', errText);
        return { error: errText };
    }

    const result = await res.json();
    if (result.errors) {
        const errMsg = result.errors.map(e => e.message).join('; ');
        console.error('Fireflies GraphQL error:', errMsg);
        return { error: errMsg };
    }

    console.log('Fireflies bot dispatched to:', meetingUri);
    return {};
}
