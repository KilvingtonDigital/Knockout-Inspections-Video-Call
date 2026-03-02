/**
 * api/status.js
 * Polled by the customer page every 3 seconds during the hold countdown.
 * Returns { accepted: bool, acceptedBy: string|null }
 */

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    // Allow the browser to cache for 0 seconds (must be fresh)
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { session } = req.query;
    if (!session) {
        return res.status(400).json({ error: 'Missing session param' });
    }

    try {
        const data = await kv.get(`session:${session}`);

        return res.status(200).json({
            accepted: data?.accepted || false,
            acceptedBy: data?.acceptedBy || null
        });
    } catch (err) {
        // If Redis is not yet configured or is down, return "not accepted"
        // so the customer countdown still runs normally — non-fatal.
        console.error('Status Redis error:', err.message);
        return res.status(200).json({ accepted: false, acceptedBy: null });
    }
}
