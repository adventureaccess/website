/**
 * /auth/github — start the GitHub OAuth flow for the CMS (Sveltia/Decap).
 *
 * Sveltia CMS with the `github` backend opens this endpoint in a popup. We
 * redirect to GitHub, storing a CSRF nonce in a short-lived cookie that
 * auth-github-callback validates. Who can actually commit is decided by GitHub
 * repo membership, not here.
 */

import crypto from 'node:crypto';

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';

export default async (req) => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const siteUrl = process.env.SITE_URL || process.env.URL || new URL(req.url).origin;
  if (!clientId) return new Response('GitHub OAuth is not configured.', { status: 500 });

  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${siteUrl}/auth/github/callback`,
    scope: 'repo',
    state,
  });

  const secure = siteUrl.startsWith('http://localhost') ? '' : ' Secure;';
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${GITHUB_AUTH_URL}?${params.toString()}`,
      'Set-Cookie': `gh_oauth=${state}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=600`,
      'Cache-Control': 'no-store',
    },
  });
};
