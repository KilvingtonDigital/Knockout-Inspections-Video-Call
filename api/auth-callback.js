/**
 * GET /api/auth-callback
 * Google redirects here after Ricky approves the OAuth consent.
 * Exchanges the authorization code for tokens and stores the refresh token in KV.
 * This only needs to run ONCE — after that, /api/accept uses the stored refresh token automatically.
 */

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    const { code, error } = req.query;

    if (error) {
        return res.status(400).send(`OAuth error: ${error}`);
    }

    if (!code) {
        return res.status(400).send('No authorization code received.');
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${proto}://${host}/api/auth-callback`;

    try {
        // Exchange authorization code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }),
        });

        const tokens = await tokenRes.json();

        if (!tokens.refresh_token) {
            return res.status(400).send(
                'No refresh token returned. Please revoke app access at myaccount.google.com/permissions and try again.'
            );
        }

        // Store refresh token in KV — used by /api/accept on every call
        await kv.set('google:calendar:refresh_token', tokens.refresh_token);

        return res.status(200).send(`
            <html><body style="font-family:sans-serif;padding:2rem;text-align:center;">
                <h2>✅ Google Calendar connected!</h2>
                <p>Otter will now automatically join each evaluation call.</p>
                <p>You can close this tab.</p>
            </body></html>
        `);
    } catch (err) {
        console.error('OAuth callback error:', err);
        return res.status(500).send('Token exchange failed. Check server logs.');
    }
}
