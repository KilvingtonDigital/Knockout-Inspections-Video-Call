/**
 * api/notify.js — Vercel serverless function
 *
 * 1. Stores session data (GPS, timestamp) in Upstash Redis
 * 2. Sends a rich Google Chat Card with:
 *    - GPS coordinates + accuracy + Maps link
 *    - Per-inspector Accept buttons (Ricky / Hunter / Nate)
 *    - A Pass button that re-alerts the team
 *
 * Payload received from frontend:
 *   POST /api/notify  { sessionId, lat, lng, acc, time, date }
 *
 * Environment variables required:
 *   CHAT_WEBHOOK_URL         — Google Chat webhook
 *   UPSTASH_REDIS_REST_URL   — auto-added by Vercel when Upstash is connected
 *   UPSTASH_REDIS_REST_TOKEN — auto-added by Vercel when Upstash is connected
 */

import { kv } from '@vercel/kv';

const MEET_LINK = 'https://meet.google.com/vnz-jgvp-ywe';
const INSPECTORS = ['Ricky', 'Hunter', 'Nate'];

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const webhookUrl = process.env.CHAT_WEBHOOK_URL;
    if (!webhookUrl) {
        return res.status(200).json({ ok: true, note: 'webhook not configured' });
    }

    // Derive base URL from request so buttons always work on any domain/preview
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const BASE_URL = `${proto}://${host}`;

    const { sessionId, lat, lng, acc, time, date } = req.body || {};

    // ── Store session in Redis ──────────────────────────────────
    if (sessionId) {
        try {
            await kv.set(`session:${sessionId}`, {
                accepted: false,
                acceptedBy: null,
                lat: lat || null,
                lng: lng || null,
                acc: acc || null,
                time: time || null,
                date: date || null
            }, { ex: 3600 }); // 1-hour TTL
        } catch (err) {
            console.error('Redis store error:', err.message);
            // Non-fatal — continue and still send Chat notification
        }
    }

    // ── Build accuracy label ────────────────────────────────────
    let accLabel = 'Not available';
    let accIcon = '❓';
    if (acc != null) {
        const metres = Number(acc);
        const readable = metres < 1000
            ? `±${Math.round(metres)} m`
            : `±${(metres / 1000).toFixed(1)} km`;
        if (metres <= 30) { accLabel = `${readable} — High Accuracy`; accIcon = '✅'; }
        else if (metres <= 150) { accLabel = `${readable} — Moderate Accuracy`; accIcon = '⚠️'; }
        else { accLabel = `${readable} — Low Accuracy`; accIcon = '🔴'; }
    }

    // ── Build URLs ──────────────────────────────────────────────
    const mapsUrl = (lat && lng)
        ? `https://www.google.com/maps/search/?api=1&query=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`
        : null;

    const coordText = (lat && lng)
        ? `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`
        : 'Not captured';

    // ── Per-inspector Accept buttons ────────────────────────────
    const acceptButtons = INSPECTORS.map(name => ({
        text: `✅ Accept — ${name}`,
        onClick: {
            openLink: {
                url: `${BASE_URL}/api/accept?session=${sessionId || 'unknown'}&name=${encodeURIComponent(name)}`
            }
        }
    }));

    // ── Pass button ─────────────────────────────────────────────
    const passButton = {
        text: '🔄 Pass — alert full team',
        onClick: {
            openLink: {
                url: `${BASE_URL}/api/pass?session=${sessionId || 'unknown'}`
            }
        }
    };

    // ── Google Chat Card (cardsV2) ──────────────────────────────
    const card = {
        cardsV2: [{
            cardId: `inspection-${Date.now()}`,
            card: {
                header: {
                    title: '📞 New Inspection Request',
                    subtitle: `${date || 'Today'} · ${time || 'now'} CT`,
                    imageType: 'CIRCLE'
                },
                sections: [
                    {
                        header: '📍 Customer Location',
                        collapsible: false,
                        widgets: [
                            {
                                decoratedText: {
                                    topLabel: 'GPS Coordinates',
                                    text: `<b>${coordText}</b>`,
                                    startIcon: { knownIcon: 'MAP_PIN' }
                                }
                            },
                            {
                                decoratedText: {
                                    topLabel: 'Accuracy',
                                    text: `${accIcon} ${accLabel}`,
                                    startIcon: { knownIcon: 'STAR' }
                                }
                            }
                        ]
                    },
                    {
                        header: '👤 Claim this call',
                        widgets: [{
                            buttonList: {
                                buttons: acceptButtons
                            }
                        }]
                    },
                    {
                        widgets: [{
                            buttonList: {
                                buttons: [
                                    passButton,
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

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(card)
        });

        // Fallback to plain text if cardsV2 rejected
        if (!response.ok) {
            const fallback = {
                text: `📞 *New inspection request* — ${time || 'now'} CT\n📍 *GPS:* ${coordText}\n${accIcon} *Accuracy:* ${accLabel}${mapsUrl ? `\n🗺️ ${mapsUrl}` : ''}\nJoin now: ${MEET_LINK}\n\nTo accept, open: ${BASE_URL}/api/accept?session=${sessionId}&name=Ricky`
            };
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fallback)
            });
        }

        return res.status(200).json({ ok: true });
    } catch (err) {
        console.error('Webhook error:', err);
        return res.status(200).json({ ok: false });
    }
}
