/**
 * /auth/callback — finish the Google sign-in flow.
 *
 * 1. Validate the CSRF state against the signed aa_oauth cookie.
 * 2. Exchange the authorization code for tokens at Google's token endpoint.
 * 3. Validate the ID token claims and authorize the email (verified AND
 *    domain/allowlist).
 * 4. Mint the session cookie and redirect back to where the user started.
 *
 * The ID token comes straight from Google's token endpoint over TLS (the
 * server-side code flow), so its claims are trustworthy without a separate
 * signature check; we still validate aud/iss/exp/email_verified.
 */

import {
  signToken,
  verifyToken,
  b64urlDecode,
  readCookie,
  isAllowedEmail,
  sessionCookie,
  SESSION_TTL_SECONDS,
} from './_auth.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function clearStateCookie(secure) {
  return `aa_oauth=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`;
}

function redirect(location, cookies) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

export default async (req) => {
  const secret = process.env.SESSION_SECRET;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const siteUrl = process.env.SITE_URL || process.env.URL || new URL(req.url).origin;
  const secure = siteUrl.startsWith('http://localhost') ? '' : ' Secure;';

  if (!secret || !clientId || !clientSecret) {
    return new Response('Auth is not configured.', { status: 500 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // 1. CSRF check — query state must match the signed state cookie.
  const stateCookie = verifyToken(readCookie(req, 'aa_oauth'), secret);
  if (!code || !state || !stateCookie || stateCookie.n !== state) {
    return redirect('/auth/login?e=state', [clearStateCookie(secure)]);
  }

  // 2. Exchange the code for tokens (server-to-server).
  let idToken;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${siteUrl}/auth/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) return redirect('/auth/login?e=exchange', [clearStateCookie(secure)]);
    idToken = (await res.json()).id_token;
  } catch {
    return redirect('/auth/login?e=exchange', [clearStateCookie(secure)]);
  }

  // 3. Decode + validate the ID token claims.
  let claims;
  try {
    claims = JSON.parse(b64urlDecode(String(idToken).split('.')[1]).toString('utf8'));
  } catch {
    return redirect('/auth/login?e=token', [clearStateCookie(secure)]);
  }

  const now = Math.floor(Date.now() / 1000);
  const email = (claims.email || '').toLowerCase();
  const okAud = claims.aud === clientId;
  const okIss = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  const okExp = typeof claims.exp === 'number' && claims.exp > now - 60; // small skew allowance
  const okVerified = claims.email_verified === true || claims.email_verified === 'true';

  if (!(okAud && okIss && okExp && okVerified && isAllowedEmail(email))) {
    return redirect('/auth/login?e=denied', [clearStateCookie(secure)]);
  }

  // 4. Mint the session, clear the state cookie, return to the start page.
  const session = signToken({ email, exp: now + SESSION_TTL_SECONDS }, secret);
  return redirect(stateCookie.rt || '/internal/dashboard/', [
    sessionCookie(session),
    clearStateCookie(secure),
  ]);
};
