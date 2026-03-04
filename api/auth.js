/**
 * GET /api/auth
 * One-time setup: redirects Ricky to Google's OAuth consent page.
 * After authorization, Google calls /api/auth-callback with a code.
 * Run this once to get a refresh token — then it's fully automatic.
 */

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

export default function handler(req, res) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${proto}://${host}/api/auth-callback`;

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('access_type', 'offline');   // gets refresh token
    url.searchParams.set('prompt', 'consent');   // forces refresh token even if previously authorized

    return res.redirect(url.toString());
}
