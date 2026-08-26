/**
 * /auth/login — start the Google sign-in flow.
 *
 * Redirects the browser to Google's consent screen. A short-lived, signed state
 * cookie carries a CSRF nonce and the (validated, same-origin) return path, so
 * auth-callback can prove the response belongs to this request.
 */

import crypto from 'node:crypto';
import { signToken } from './_auth.mjs';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Only allow same-origin relative return paths (no open redirect). */
function safeReturnPath(rt) {
  if (typeof rt === 'string' && rt.startsWith('/') && !rt.startsWith('//')) return rt;
  return '/internal/dashboard/';
}

export default async (req) => {
  const secret = process.env.SESSION_SECRET;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const siteUrl = process.env.SITE_URL || process.env.URL || new URL(req.url).origin;

  if (!secret || !clientId) {
    return new Response('Auth is not configured.', { status: 500 });
  }

  const returnTo = safeReturnPath(new URL(req.url).searchParams.get('rt'));
  const nonce = crypto.randomBytes(16).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const stateCookie = signToken({ n: nonce, rt: returnTo, exp: now + 600 }, secret);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${siteUrl}/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state: nonce,
    prompt: 'select_account',
    access_type: 'online',
  });
  // Workspace hint only — real domain enforcement happens server-side in the callback.
  const hd = process.env.ALLOWED_DOMAIN;
  if (hd) params.set('hd', hd);

  const secure = siteUrl.startsWith('http://localhost') ? '' : ' Secure;';
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${GOOGLE_AUTH_URL}?${params.toString()}`,
      'Set-Cookie': `aa_oauth=${stateCookie}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=600`,
      'Cache-Control': 'no-store',
    },
  });
};
