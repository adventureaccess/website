/**
 * Session auth for the internal dashboard's data functions.
 *
 * This replaces the old Netlify Identity / GoTrue guard (_identity.mjs). Access
 * is now a Google sign-in: the auth-* functions verify a Google account and mint
 * a signed session cookie; here we verify that cookie locally (HMAC, no network
 * round-trip) and check the email is allowed.
 *
 * This is the ONE place access is decided for the data functions. They should
 * never inspect cookies or tokens themselves — they call requireUser().
 *
 * Access requires a valid, unexpired `aa_session` cookie whose email is EITHER
 * on the ALLOWED_DOMAIN (e.g. @adventure-access.com) OR in the ALLOWED_EMAILS
 * allowlist. Revoke access by editing those env vars; rotate SESSION_SECRET to
 * invalidate every live session at once.
 */

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'aa_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export const JSON_HEADERS = {
  'Content-Type': 'application/json',
  // Same-origin in practice; the browser sends the session cookie automatically.
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** Same-origin only — no wildcard, since these endpoints return private data. */
export function corsHeaders(req) {
  const origin = process.env.SITE_URL || process.env.URL || new URL(req.url).origin;
  return { ...JSON_HEADERS, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

export function unauthorized(req, message = 'Authentication required.') {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: corsHeaders(req),
  });
}

// ---- base64url + HMAC token helpers ---------------------------------------
// A session token is "<b64url(json)>.<b64url(hmac-sha256(json))>" over a small
// payload { email, exp }. No JWT library: we control both signer and verifier
// and only need two fields, so hand-rolling with node:crypto avoids a dependency
// and the alg-confusion surface a JWT library brings.

export function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signToken(payload, secret) {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * Verify a signed token. Returns the payload object, or null if the signature
 * is wrong, the token is malformed, or it has expired.
 */
export function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard first.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** Read a single cookie value from the request, or null. */
export function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  const match = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

/** True if this email is allowed in (domain match OR explicit allowlist). */
export function isAllowedEmail(email) {
  const addr = (email || '').toLowerCase().trim();
  if (!addr) return false;
  const domain = (process.env.ALLOWED_DOMAIN || '').toLowerCase().trim();
  const list = (process.env.ALLOWED_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const domainOk = domain && addr.endsWith('@' + domain);
  return Boolean(domainOk) || list.includes(addr);
}

/** Cookie attributes for the session. `Secure` is dropped for localhost dev. */
export function sessionCookie(value, maxAgeSeconds) {
  const siteUrl = process.env.SITE_URL || process.env.URL || '';
  const secure = siteUrl.startsWith('http://localhost') ? '' : ' Secure;';
  const maxAge = maxAgeSeconds == null ? SESSION_TTL_SECONDS : maxAgeSeconds;
  return `${SESSION_COOKIE}=${value}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/**
 * Resolve the caller from the session cookie, or null. No network I/O — the
 * cookie is verified locally against SESSION_SECRET. Signature kept as
 * (req, context) so the data functions can call it unchanged.
 *
 * @returns {Promise<{email: string}|null>}
 */
export async function requireUser(req /* , context */) {
  const payload = verifyToken(readCookie(req, SESSION_COOKIE), process.env.SESSION_SECRET);
  if (!payload || !isAllowedEmail(payload.email)) return null;
  return { email: payload.email };
}
