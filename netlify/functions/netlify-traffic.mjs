/**
 * Netlify Analytics (server-side traffic) for the internal marketing dashboard.
 *
 * WHY: Netlify counts every HTTP request that reaches the edge — including bots,
 * scrapers, AI crawlers and vulnerability scanners. GA4 only counts real
 * browsers running JavaScript. Putting the two side by side turns the gap into
 * the useful number: roughly how much of the "traffic" isn't a person.
 *
 * For context on why that matters here: a sample week showed Netlify reporting
 * 7,617 page views, ~60% of them from a single data-centre region, with the
 * "not found" list topped by /wp-login.php (304 attempts), /xmlrpc.php and
 * /.env — none of which exist on this Astro site. GA4 saw a small fraction of
 * that. The dashboard should show both, never add them together.
 *
 * ⚠️ UNOFFICIAL API. These endpoints are not in Netlify's public documentation;
 * they were found by inspecting the Netlify UI's own network calls and are
 * widely used but unsupported. They can change or disappear without notice, so
 * this function is written to fail soft: on any problem it returns HTTP 200 with
 * { available: false, reason } and the dashboard just hides the comparison. It
 * must never take the rest of the dashboard down.
 *
 * Environment variables:
 *   NETLIFY_TOKEN    – Netlify personal access token (User settings →
 *                      Applications → Personal access tokens).
 *                      ⚠️ Netlify PATs are NOT scopable: this grants full API
 *                      access to the account, so treat it as a high-value
 *                      secret. It lives only in Netlify env vars and can be
 *                      revoked from the same screen.
 *   NETLIFY_SITE_ID  – optional; defaults to the adventure-access.com project.
 *
 * Usage (requires a Netlify Identity bearer token with the "dashboard" role):
 *   GET /.netlify/functions/netlify-traffic?days=30
 */

import { requireUser, unauthorized, corsHeaders } from './_identity.mjs';

const DEFAULT_SITE_ID = '52d84b14-344a-45ce-a108-0a8b47d29057';
const BASE = 'https://analytics.services.netlify.com/v2';

/** Soft failure — 200 so the dashboard can degrade instead of erroring. */
function unavailable(req, reason, extra = {}) {
  return new Response(
    JSON.stringify({ available: false, reason, source: 'netlify', ...extra }),
    { status: 200, headers: corsHeaders(req) }
  );
}

/** YYYYMMDD in UTC, to match the keys GA4 returns. */
function dateKey(ms) {
  const d = new Date(ms);
  return (
    d.getUTCFullYear() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

/**
 * The response has been seen as { data: [[timestampMs, count], ...] }. Parse
 * defensively — this is an undocumented shape that could drift.
 */
function normalisePageviews(json) {
  const data = json && (json.data ?? json);
  if (!Array.isArray(data)) return null;

  const rows = [];
  for (const entry of data) {
    let ts, count;
    if (Array.isArray(entry)) {
      [ts, count] = entry;
    } else if (entry && typeof entry === 'object') {
      ts = entry.timestamp ?? entry.time ?? entry[0];
      count = entry.count ?? entry.value ?? entry.pageviews ?? entry[1];
    } else {
      continue;
    }
    if (ts == null || count == null) continue;
    const ms = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts); // sec or ms
    rows.push({ key: dateKey(ms), pageviews: Number(count) || 0 });
  }
  return rows.length ? rows : null;
}

async function fetchNetlify(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null; caller reports it */
  }
  return { ok: res.ok, status: res.status, json, text };
}

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: corsHeaders(req) });
  }

  const user = await requireUser(req, context);
  if (!user) return unauthorized(req);

  const token = process.env.NETLIFY_TOKEN;
  if (!token) {
    return unavailable(req, 'NETLIFY_TOKEN is not set.');
  }

  const siteId = process.env.NETLIFY_SITE_ID || DEFAULT_SITE_ID;
  const url = new URL(req.url);
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '30', 10)));

  const to = Date.now();
  const from = to - days * 86_400_000;

  try {
    const qs = `from=${from}&to=${to}&timezone=%2B0000&resolution=day`;
    let res = await fetchNetlify(`${BASE}/${siteId}/pageviews?${qs}`, token);

    // Some deployments of this endpoint have wanted seconds rather than ms.
    if (!res.ok || !normalisePageviews(res.json)) {
      const qsSec = `from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}&timezone=%2B0000&resolution=day`;
      const retry = await fetchNetlify(`${BASE}/${siteId}/pageviews?${qsSec}`, token);
      if (retry.ok && normalisePageviews(retry.json)) res = retry;
    }

    if (!res.ok) {
      // 401/403 usually means a bad or revoked token; 404 means Netlify
      // Analytics isn't enabled for this project.
      return unavailable(req, `Netlify analytics API returned ${res.status}.`, {
        hint:
          res.status === 401 || res.status === 403
            ? 'Check NETLIFY_TOKEN — it may be revoked or lack access to this project.'
            : res.status === 404
              ? 'Netlify Analytics may not be enabled for this project.'
              : undefined,
      });
    }

    const rows = normalisePageviews(res.json);
    if (!rows) {
      return unavailable(req, 'Unexpected response shape from the Netlify analytics API.', {
        sample: (res.text || '').slice(0, 200),
      });
    }

    const total = rows.reduce((sum, r) => sum + r.pageviews, 0);

    return new Response(
      JSON.stringify({
        available: true,
        source: 'netlify',
        note: 'Server-side request counts. Includes bots, scrapers and scanners. Not comparable to GA4 one-for-one, and never additive with it.',
        siteId,
        windowDays: days,
        total,
        rows,
        updatedAt: new Date().toISOString(),
      }),
      { status: 200, headers: corsHeaders(req) }
    );
  } catch (err) {
    return unavailable(req, String((err && err.message) || err));
  }
};
