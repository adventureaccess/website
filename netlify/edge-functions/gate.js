/**
 * Edge gate for /internal/* — bounce unauthenticated visitors to /auth/login.
 *
 * This is defense-in-depth and UX, not the security boundary: the dashboard
 * shell contains no data, and the real enforcement is requireUser() in the data
 * functions. This just avoids showing an empty shell to signed-out visitors and
 * sends them straight to Google sign-in.
 *
 * Runs in Netlify's Deno runtime, so it verifies the session cookie with Web
 * Crypto (SubtleCrypto HMAC) rather than node:crypto. It mirrors the token
 * format minted in netlify/functions/_auth.mjs: "<b64url(json)>.<b64url(hmac)>".
 *
 * Fails closed: any error, missing secret, or bad/expired cookie → redirect to
 * login.
 */

const SESSION_COOKIE = 'aa_session';

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  const match = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verify(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), new TextEncoder().encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export default async (request, context) => {
  const secret = Netlify.env.get('SESSION_SECRET');
  const payload = await verify(readCookie(request, SESSION_COOKIE), secret);
  if (payload) return context.next();

  const url = new URL(request.url);
  const loginUrl = `${url.origin}/auth/login?rt=${encodeURIComponent(url.pathname + url.search)}`;
  return Response.redirect(loginUrl, 302);
};

export const config = { path: '/internal/*' };
