/**
 * Netlify Identity auth guard for the internal dashboard's data functions.
 *
 * This is the ONE place access is decided. Netlify Identity and Git Gateway are
 * deprecated (they keep working and still get security fixes, but no bug fixes),
 * so when the CMS auth eventually migrates — DecapBridge or any other JWT issuer
 * — this file is the only thing that needs rewriting. Keep it that way: data
 * functions should never inspect tokens themselves.
 *
 * Access requires BOTH:
 *   1. a valid Identity session, and
 *   2. the "dashboard" role in the user's app_metadata.roles
 *
 * Grant the role in Netlify → Identity → (user) → Edit user metadata:
 *   { "roles": ["dashboard"] }
 *
 * Roles are checked rather than an email allowlist so access can be revoked in
 * the Netlify UI without a deploy.
 */

const REQUIRED_ROLE = 'dashboard';

export const JSON_HEADERS = {
  'Content-Type': 'application/json',
  // Same-origin in practice; the dashboard sends a bearer token, never cookies.
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** Same-origin only — no wildcard, since these endpoints return private data. */
export function corsHeaders(req) {
  const origin = process.env.URL || new URL(req.url).origin;
  return { ...JSON_HEADERS, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

export function unauthorized(req, message = 'Authentication required.') {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: corsHeaders(req),
  });
}

function bearerToken(req) {
  const header = req.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function hasRole(user) {
  const roles = user?.app_metadata?.roles ?? [];
  return Array.isArray(roles) && roles.includes(REQUIRED_ROLE);
}

/**
 * Resolve the caller's Identity user, or null.
 *
 * Two paths, because this project uses the modern (v2) function signature and
 * `context.clientContext.user` — the documented Identity hook — is only reliably
 * populated for legacy-style functions. So: use it when it's there, otherwise
 * validate the token against the site's own Identity (GoTrue) endpoint, which
 * needs no secret and is authoritative.
 *
 * @returns {Promise<object|null>} the verified user, or null if unauthenticated
 *   or missing the required role.
 */
export async function requireUser(req, context) {
  const fromContext = context?.clientContext?.user;
  if (fromContext) return hasRole(fromContext) ? fromContext : null;

  const token = bearerToken(req);
  if (!token) return null;

  const base = process.env.URL || new URL(req.url).origin;
  try {
    const res = await fetch(`${base}/.netlify/identity/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return hasRole(user) ? user : null;
  } catch {
    return null;
  }
}
