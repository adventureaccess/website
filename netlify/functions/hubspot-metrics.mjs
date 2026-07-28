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
 * Environment variables:
 *   HUBSPOT_TOKEN – a HubSpot **service key** with scope crm.objects.contacts.read.
 *     Create at: HubSpot → Development → Keys → Service keys (public beta as of
 *     Feb 2026, and HubSpot's recommended credential for single-account,
 *     system-to-system API access). Legacy private app tokens also work — both
 *     are sent as `Authorization: Bearer <token>` — so nothing here changes if
 *     the credential type is ever swapped.
 *
 * Usage (requires a Netlify Identity bearer token with the "dashboard" role):
 *   GET /.netlify/functions/hubspot-metrics          → last 30 days
 *   GET /.netlify/functions/hubspot-metrics?days=7   → last 7 days
 */

import { requireUser, unauthorized, corsHeaders } from './_identity.mjs';

const SEARCH_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
const PORTAL_ID = '244183775';
const PROPERTIES = ['email', 'firstname', 'lastname', 'createdate', 'lifecyclestage'];

/** One search request; returns { total, results }. */
async function searchContacts(token, fromMs, toMs, limit) {
  const filters = [{ propertyName: 'createdate', operator: 'GTE', value: String(fromMs) }];
  if (toMs) filters.push({ propertyName: 'createdate', operator: 'LT', value: String(toMs) });

  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filterGroups: [{ filters }],
      properties: PROPERTIES,
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit,
    }),
  });

  if (!res.ok) {
    throw Object.assign(new Error(`HubSpot API error (${res.status})`), {
      status: res.status,
      detail: await res.text(),
    });
  }
  return res.json();
}

function displayName(props) {
  const name = [props.firstname, props.lastname].filter(Boolean).join(' ').trim();
  return name || props.email || 'Unknown contact';
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

  const dayMs = 86_400_000;
  const now = Date.now();
  const windowStart = now - days * dayMs;
  const priorStart = now - 2 * days * dayMs;

  try {
    // Current window (with the contact list) and the window before it (count only,
    // for a period-over-period comparison).
    const [current, prior] = await Promise.all([
      searchContacts(token, windowStart, null, 50),
      searchContacts(token, priorStart, windowStart, 1),
    ]);

    const contacts = (current.results || []).map((c) => {
      const props = c.properties || {};
      return {
        id: c.id,
        name: displayName(props),
        email: props.email || null,
        createdate: props.createdate || null,
        lifecyclestage: props.lifecyclestage || null,
        url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-1/${c.id}`,
      };
    });

    // Lifecycle stage tallies, for a quick read on funnel shape.
    const byStage = {};
    for (const c of contacts) {
      const stage = c.lifecyclestage || 'unknown';
      byStage[stage] = (byStage[stage] || 0) + 1;
    }

    return new Response(
      JSON.stringify({
        portalId: PORTAL_ID,
        windowDays: days,
        total: current.total ?? contacts.length,
        previousTotal: prior.total ?? 0,
        contacts,
        byStage,
        updatedAt: new Date().toISOString(),
      }),
      { status: 200, headers: corsHeaders(req) }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err.message || err), detail: err.detail }),
      { status: err.status === 401 || err.status === 403 ? 502 : 500, headers: corsHeaders(req) }
    );
  }
};
