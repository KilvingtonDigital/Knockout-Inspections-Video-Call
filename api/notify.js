/**
 * api/notify.js — Vercel serverless function
 *
 * Proxies the Google Chat webhook so the secret URL never
 * appears in client-side HTML. The real webhook URL is stored
 * as the environment variable CHAT_WEBHOOK_URL in Vercel.
 *
 * Called by the landing page:
 *   POST /api/notify  { lat, lng, time }
 */

export default async function handler(req, res) {
    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const webhookUrl = process.env.CHAT_WEBHOOK_URL;
    if (!webhookUrl) {
        // Silently succeed if webhook not configured — don't break customer flow
        return res.status(200).json({ ok: true, note: 'webhook not configured' });
    }

    const { lat, lng, time } = req.body || {};

    const coordLine = (lat && lng)
        ? `\n📍 *GPS:* ${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}\n🗺️ https://www.google.com/maps/search/?api=1&query=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`
        : '\n⚠️ GPS not captured';

    const payload = {
        text: `📞 *New virtual inspection request* — ${time || 'unknown time'} CT${coordLine}\nPlease join the room now: https://meet.google.com/vnz-jgvp-ywe`
    };

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return res.status(200).json({ ok: response.ok });
    } catch (err) {
        // Log server-side but don't expose to client
        console.error('Webhook error:', err);
        return res.status(200).json({ ok: false });
    }
}
