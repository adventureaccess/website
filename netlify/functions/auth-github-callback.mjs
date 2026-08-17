/**
 * /auth/github/callback — finish GitHub OAuth for the CMS.
 *
 * Validates the CSRF state, exchanges the code for an access token, and hands
 * the token back to the CMS window using the postMessage handshake that
 * Decap/Sveltia expect ("authorization:github:success:<json>").
 */

import { readCookie } from './_auth.mjs';

const TOKEN_URL = 'https://github.com/login/oauth/access_token';

function page(body) {
  return new Response(`<!doctype html><html><body>${body}</body></html>`, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function resultScript(status, payload) {
  // Decap/Sveltia expect: "authorization:github:<status>:<json>" where <json>
  // is { token, provider } on success, or the error string. Build the full
  // message server-side and inject it as a single JS string literal.
  const message = `authorization:github:${status}:${JSON.stringify(payload)}`;
  return page(`<script>
    (function () {
      function receiveMessage(e) {
        window.opener.postMessage(${JSON.stringify(message)}, e.origin);
        window.removeEventListener('message', receiveMessage, false);
      }
      window.addEventListener('message', receiveMessage, false);
      window.opener.postMessage('authorizing:github', '*');
    })();
  </script>`);
}

export default async (req) => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return resultScript('error', 'GitHub OAuth is not configured.');
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== readCookie(req, 'gh_oauth')) {
    return resultScript('error', 'Invalid OAuth state.');
  }

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${process.env.SITE_URL || new URL(req.url).origin}/auth/github/callback`,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      return resultScript('error', data.error_description || 'Token exchange failed.');
    }
    return resultScript('success', { token: data.access_token, provider: 'github' });
  } catch (e) {
    return resultScript('error', e.message || 'Token exchange failed.');
  }
};
