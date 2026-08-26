/**
 * /auth/logout — clear the session cookie and return to the homepage.
 */

import { SESSION_COOKIE } from './_auth.mjs';

export default async (req) => {
  const siteUrl = process.env.SITE_URL || process.env.URL || new URL(req.url).origin;
  const secure = siteUrl.startsWith('http://localhost') ? '' : ' Secure;';
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`,
      'Cache-Control': 'no-store',
    },
  });
};
