/**
 * GA4 page-views proxy for the marketing dashboard.
 *
 * Why this exists: the GA4 Data API uses service-account OAuth, which can't be
 * called safely from the browser (the private key can't be exposed client-side).
 * This Netlify Function holds the key server-side, fetches page views from GA4,
 * and returns simple JSON the dashboard can read.
 *
 * Environment variables (set in Netlify → Site settings → Environment variables):
 *   GA4_SA_KEY       – the full service-account JSON, pasted as a single value
 *   GA4_PROPERTY_ID  – the numeric GA4 property ID (e.g. 522290801), NOT the G- id
 *
 * Access: requires a Netlify Identity bearer token with the "dashboard" role.
 * This endpoint was previously public — anyone with the URL could read the site's
 * traffic numbers — so it is now gated like every other dashboard data source.
 * Nothing automated depended on it being open.
 *
 * Usage:
 *   GET /.netlify/functions/pageviews              → last 30 days, daily totals
 *   GET /.netlify/functions/pageviews?days=7       → last 7 days
 *   GET /.netlify/functions/pageviews?breakdown=page → per-page totals for the window
 */

import crypto from 'node:crypto';
import { requireUser, unauthorized, corsHeaders } from './_identity.mjs';

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Exchange the service-account key for a short-lived OAuth access token. */
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token;
}

export default async (req, context) => {
  const CORS = corsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: CORS });
  }

  const user = await requireUser(req, context);
  if (!user) return unauthorized(req);

  const propertyId = process.env.GA4_PROPERTY_ID;
  const rawKey = process.env.GA4_SA_KEY;
  if (!propertyId || !rawKey) {
    return new Response(
      JSON.stringify({ error: 'Missing GA4_PROPERTY_ID or GA4_SA_KEY env var.' }),
      { status: 500, headers: CORS }
    );
  }

  let sa;
  try {
    sa = JSON.parse(rawKey);
  } catch {
    return new Response(
      JSON.stringify({ error: 'GA4_SA_KEY is not valid JSON.' }),
      { status: 500, headers: CORS }
    );
  }

  const url = new URL(req.url);
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '30', 10)));
  const breakdown = url.searchParams.get('breakdown'); // "page" for per-page

  const reportBody = breakdown === 'page'
    ? {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 100,
      }
    : {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      };

  try {
    const token = await getAccessToken(sa);
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reportBody),
      }
    );
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `GA4 API error (${res.status})`, detail: await res.text() }),
        { status: 502, headers: CORS }
      );
    }
    const data = await res.json();

    const rows = (data.rows || []).map((r) => ({
      key: r.dimensionValues[0].value,
      pageviews: Number(r.metricValues[0].value),
    }));
    const total = rows.reduce((sum, r) => sum + r.pageviews, 0);

    return new Response(
      JSON.stringify({
        propertyId,
        windowDays: days,
        breakdown: breakdown === 'page' ? 'page' : 'date',
        total,
        rows,
        updatedAt: new Date().toISOString(),
      }),
      { status: 200, headers: CORS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err.message || err) }),
      { status: 500, headers: CORS }
    );
  }
};
