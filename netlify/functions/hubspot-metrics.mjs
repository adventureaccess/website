/**
 * HubSpot conversion metrics for the internal marketing dashboard.
 *
 * Pairs with pageviews.mjs (GA4 traffic). The split matters and is deliberate:
 *   GA4      → how many humans visited
 *   HubSpot  → the trackable subset that turned into CRM contacts
 * These are different questions. Don't present them as rival traffic counts.
 *
 * Uses the CRM v3 Search API only, which is available on every HubSpot tier —
 * deliberately NOT the content-analytics endpoints, which need Marketing Hub Pro.
 *
 * ⚠️ RATE LIMIT: HubSpot caps the search endpoints at FIVE requests per second
 * per account (not per app). An earlier version of this function fired eight
 * searches in parallel and reliably got 429s. Hence three defences here:
 *   1. Six searches, not eight — per-campaign counts come from one query each
 *      (window / all time) and are tallied in code rather than one query per
 *      campaign.
 *   2. Requests run in batches of three with a gap, never all at once.
 *   3. A 60-second in-memory cache, so opening the dashboard, hitting Refresh,
 *      or flipping the window doesn't re-hit HubSpot every time. Netlify keeps
 *      function instances warm, so this survives between requests.
 * Plus a bounded retry that honours Retry-After.
 *
 * Environment variables:
 *   HUBSPOT_TOKEN – HubSpot service key with scope crm.objects.contacts.read.
 *     Create at: HubSpot → Development → Keys → Service keys. Legacy private app
 *     tokens work identically (both are `Authorization: Bearer <token>`).
 *
 * Usage (requires a Netlify Identity bearer token with the "dashboard" role):
 *   GET /.netlify/functions/hubspot-metrics?days=30
 */

import { requireUser, unauthorized, corsHeaders } from './_identity.mjs';

const SEARCH_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
const PORTAL_ID = '244183775';
const PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'createdate',
  'lifecyclestage',
  'campaign_source_page',
  'recent_conversion_event_name',
];

/**
 * Paid-campaign landing pages. The slug matches the `campaign` prop on each
 * page, which is what gets written to the campaign_source_page contact property.
 */
const CAMPAIGNS = [
  { slug: 'nepal-lp01', label: 'Nepal LP01' },
  { slug: 'india-lp01', label: 'India LP01' },
];

const CACHE_TTL_MS = 60_000;
// Six searches spread so no ROLLING one-second window ever holds more than four.
// Batches of 3 with a 400ms gap were measured putting all six inside one second
// — the limit is per rolling second, not per batch. 2 × 550ms gives batches at
// 0/550/1100ms, so any 1s window contains at most two batches = 4 requests.
const BATCH_SIZE = 2;
const BATCH_GAP_MS = 550;
const MAX_PAGE = 200; // HubSpot's per-page maximum

/** key → { at, payload } */
const cache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One search request, with a bounded retry when rate limited. */
async function hsSearch(token, body, attempt = 0) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 429 && attempt < 2) {
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 900 * (attempt + 1));
    return hsSearch(token, body, attempt + 1);
  }

  if (!res.ok) {
    throw Object.assign(new Error(`HubSpot API error (${res.status})`), {
      status: res.status,
      detail: (await res.text()).slice(0, 300),
    });
  }
  return res.json();
}

/** Run thunks in small batches so we stay under five searches per second. */
async function inBatches(thunks) {
  const out = [];
  for (let i = 0; i < thunks.length; i += BATCH_SIZE) {
    if (i) await sleep(BATCH_GAP_MS);
    out.push(...(await Promise.all(thunks.slice(i, i + BATCH_SIZE).map((t) => t()))));
  }
  return out;
}

function displayName(props) {
  const name = [props.firstname, props.lastname].filter(Boolean).join(' ').trim();
  return name || props.email || 'Unknown contact';
}

/** Count occurrences of each campaign slug across returned records. */
function tallyCampaigns(json) {
  const counts = {};
  for (const r of json.results || []) {
    const slug = r.properties && r.properties.campaign_source_page;
    if (slug) counts[slug] = (counts[slug] || 0) + 1;
  }
  // If a query matched more than one page, the tally is a floor, not a total.
  const truncated = (json.total ?? 0) > (json.results || []).length;
  return { counts, truncated };
}

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: corsHeaders(req) });
  }

  const user = await requireUser(req, context);
  if (!user) return unauthorized(req);

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'Missing HUBSPOT_TOKEN env var.' }), {
      status: 500,
      headers: corsHeaders(req),
    });
  }

  const url = new URL(req.url);
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '30', 10)));

  const cacheKey = `days=${days}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return new Response(JSON.stringify({ ...hit.payload, cached: true }), {
      status: 200,
      headers: corsHeaders(req),
    });
  }

  const dayMs = 86_400_000;
  const now = Date.now();
  const windowStart = now - days * dayMs;
  const priorStart = now - 2 * days * dayMs;

  const createdFilter = (from, to) => {
    const f = [{ propertyName: 'createdate', operator: 'GTE', value: String(from) }];
    if (to) f.push({ propertyName: 'createdate', operator: 'LT', value: String(to) });
    return f;
  };
  const convertedFilter = (from, to) => {
    const f = [{ propertyName: 'recent_conversion_date', operator: 'GTE', value: String(from) }];
    if (to) f.push({ propertyName: 'recent_conversion_date', operator: 'LT', value: String(to) });
    return f;
  };
  const search = (filters, properties, limit, sorts) => () =>
    hsSearch(token, {
      filterGroups: [{ filters }],
      properties,
      limit,
      ...(sorts ? { sorts } : {}),
    });

  try {
    // Six searches, batched. Order matters only for readability below.
    const [current, prior, conversions, priorConversions, campaignWindow, campaignAll] =
      await inBatches([
        // New contacts in the window, with the list for the table.
        search(createdFilter(windowStart, null), PROPERTIES, 50, [
          { propertyName: 'createdate', direction: 'DESCENDING' },
        ]),
        // New contacts in the preceding window (count only).
        search(createdFilter(priorStart, windowStart), ['email'], 1),
        // Conversions — any form — by conversion date, so repeat submitters count.
        search(convertedFilter(windowStart, null), ['email'], 1),
        search(convertedFilter(priorStart, windowStart), ['email'], 1),
        // Per-campaign: one query each, tallied in code (was one query per
        // campaign, which is what tripped the rate limit).
        search(
          [
            ...convertedFilter(windowStart, null),
            { propertyName: 'campaign_source_page', operator: 'HAS_PROPERTY' },
          ],
          ['campaign_source_page'],
          MAX_PAGE
        ),
        search(
          [{ propertyName: 'campaign_source_page', operator: 'HAS_PROPERTY' }],
          ['campaign_source_page'],
          MAX_PAGE
        ),
      ]);

    const windowTally = tallyCampaigns(campaignWindow);
    const allTally = tallyCampaigns(campaignAll);

    const campaigns = CAMPAIGNS.map((c) => ({
      slug: c.slug,
      label: c.label,
      inWindow: windowTally.counts[c.slug] || 0,
      allTime: allTally.counts[c.slug] || 0,
    }));

    const contacts = (current.results || []).map((c) => {
      const props = c.properties || {};
      return {
        id: c.id,
        name: displayName(props),
        email: props.email || null,
        createdate: props.createdate || null,
        lifecyclestage: props.lifecyclestage || null,
        campaign: props.campaign_source_page || null,
        url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-1/${c.id}`,
      };
    });

    const byStage = {};
    for (const c of contacts) {
      const stage = c.lifecyclestage || 'unknown';
      byStage[stage] = (byStage[stage] || 0) + 1;
    }

    const payload = {
      portalId: PORTAL_ID,
      windowDays: days,
      total: current.total ?? contacts.length,
      previousTotal: prior.total ?? 0,
      conversions: conversions.total ?? 0,
      previousConversions: priorConversions.total ?? 0,
      campaigns,
      campaignsTruncated: windowTally.truncated || allTally.truncated,
      contacts,
      byStage,
      updatedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, { at: Date.now(), payload });

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders(req) });
  } catch (err) {
    const rateLimited = err.status === 429;

    // Serve stale cache rather than nothing — a slightly old number beats an
    // error page on an internal dashboard.
    if (hit) {
      return new Response(
        JSON.stringify({
          ...hit.payload,
          cached: true,
          stale: true,
          warning: rateLimited
            ? 'HubSpot rate limit hit; showing the last successful figures.'
            : `HubSpot error; showing the last successful figures. ${err.message}`,
        }),
        { status: 200, headers: corsHeaders(req) }
      );
    }

    return new Response(
      JSON.stringify({
        error: rateLimited
          ? 'HubSpot rate limit reached (its search API allows five requests per second per account). Try again in a moment.'
          : String(err.message || err),
        detail: err.detail,
        rateLimited,
      }),
      { status: rateLimited ? 429 : 500, headers: corsHeaders(req) }
    );
  }
};
