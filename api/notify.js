/**
 * api/notify.js — Vercel serverless function
 *
 * Sends a rich Google Chat Card to the team when a customer
 * joins the virtual inspection portal. Webhook URL is stored
 * as the Vercel environment variable CHAT_WEBHOOK_URL.
 *
 * Payload received from frontend:
 *   POST /api/notify  { lat, lng, acc, time, date }
 */

const MEET_LINK = 'https://meet.google.com/vnz-jgvp-ywe';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const webhookUrl = process.env.CHAT_WEBHOOK_URL;
    if (!webhookUrl) {
        return res.status(200).json({ ok: true, note: 'webhook not configured' });
    }

    const { lat, lng, acc, time, date } = req.body || {};

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

    // ── Build Maps URL ──────────────────────────────────────────
    const mapsUrl = (lat && lng)
        ? `https://www.google.com/maps/search/?api=1&query=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`
        : null;

    const coordText = (lat && lng)
        ? `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`
        : 'Not captured';

    // ── Google Chat Card (cardsV2) ──────────────────────────────
    const card = {
        cardsV2: [{
            cardId: `inspection-${Date.now()}`,
            card: {
                header: {
                    title: '📞 New Inspection Request',
                    subtitle: `${date || 'Today'} · ${time || 'now'} CT`,
                    imageUrl: 'https://lh3.googleusercontent.com/d/1bsHn3KTQHi4hX9GG4FTLQ',
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
                        widgets: [
                            {
                                buttonList: {
                                    buttons: [
                                        ...(mapsUrl ? [{
                                            text: '🗺️ Open in Google Maps',
                                            onClick: { openLink: { url: mapsUrl } },
                                            color: { red: 0.161, green: 0.341, blue: 0.192, alpha: 1 }
                                        }] : []),
                                        {
                                            text: '📹 Join Meet Now',
                                            onClick: { openLink: { url: MEET_LINK } },
                                            color: { red: 0.741, green: 0.118, blue: 0.180, alpha: 1 }
                                        }
                                    ]
                                }
                            }
                        ]
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

        // If cardsV2 not accepted, fall back to plain text
        if (!response.ok) {
            const fallback = {
                text: `📞 *New virtual inspection request* — ${time || 'now'} CT\n📍 *GPS:* ${coordText}\n${accIcon} *Accuracy:* ${accLabel}${mapsUrl ? `\n🗺️ ${mapsUrl}` : ''}\nJoin now: ${MEET_LINK}`
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
