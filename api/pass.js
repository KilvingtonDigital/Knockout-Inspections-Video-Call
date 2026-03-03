/**
 * api/pass.js
 * Inspector taps "Pass" in Google Chat → opens this URL (GET).
 * Fires a fresh "Coverage needed" card to the team with per-inspector Accept buttons.
 */

import { kv } from '@vercel/kv';

const MEET_LINK = 'https://meet.google.com/vnz-jgvp-ywe';
const INSPECTORS = ['Ricky', 'Hunter', 'Nate'];

export default async function handler(req, res) {
    const { session } = req.query;

    // Derive base URL from request so Accept buttons always work on any domain
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const BASE_URL = `${proto}://${host}`;

    // Try to fetch stored GPS data for the session
    let sessionData = null;
    if (session) {
        try {
            sessionData = await kv.get(`session:${session}`);
        } catch (_) { /* non-fatal */ }
    }

    const coordText = (sessionData?.lat && sessionData?.lng)
        ? `${Number(sessionData.lat).toFixed(6)}, ${Number(sessionData.lng).toFixed(6)}`
        : 'Not available';

    const mapsUrl = (sessionData?.lat && sessionData?.lng)
        ? `https://www.google.com/maps/search/?api=1&query=${Number(sessionData.lat).toFixed(6)},${Number(sessionData.lng).toFixed(6)}`
        : null;

    // Accept buttons for each inspector
    const acceptButtons = INSPECTORS.map(name => ({
        text: `✅ Accept — ${name}`,
        onClick: {
            openLink: {
                url: `${BASE_URL}/api/accept?session=${session || 'unknown'}&name=${encodeURIComponent(name)}`
            }
        }
    }));

    const webhookUrl = process.env.CHAT_WEBHOOK_URL;
    if (webhookUrl) {
        const card = {
            cardsV2: [{
                cardId: `pass-${Date.now()}`,
                card: {
                    header: {
                        title: '🔄 Coverage Needed',
                        subtitle: 'Evaluator passed — first available please accept'
                    },
                    sections: [
                        {
                            header: '📍 Customer Location',
                            widgets: [{
                                decoratedText: {
                                    topLabel: 'GPS Coordinates',
                                    text: `<b>${coordText}</b>`,
                                    startIcon: { knownIcon: 'MAP_PIN' }
                                }
                            }]
                        },
                        {
                            widgets: [{
                                buttonList: {
                                    buttons: [
                                        ...acceptButtons,
                                        ...(mapsUrl ? [{
                                            text: '🗺️ Google Maps',
                                            onClick: { openLink: { url: mapsUrl } }
                                        }] : [])
                                    ]
                                }
                            }]
                        }
                    ]
                }
            }]
        };

        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(card)
        }).catch(() => { });
    }

    // Show simple confirmation page to the inspector
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;color:#292458">
        <h2>🔄 Passed</h2>
        <p>Your team has been notified. You can close this tab.</p>
        <p style="margin-top:24px"><a href="${MEET_LINK}" style="color:#bd1e2e;font-weight:bold">Join Meet anyway →</a></p>
    </body></html>`);
}
