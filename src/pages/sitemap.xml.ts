import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import destinations from '../data/destinations.json';

const SITE = 'https://www.adventure-access.com';

const staticUrls = [
  { loc: '/',                                  priority: '1.0', changefreq: 'weekly'  },
  { loc: '/about/',                            priority: '0.7', changefreq: 'monthly' },
  { loc: '/transformational-travel/',          priority: '0.9', changefreq: 'monthly' },
  { loc: '/destinations/',                     priority: '0.9', changefreq: 'monthly' },
  { loc: '/tours/',                            priority: '0.9', changefreq: 'weekly'  },
  { loc: '/plan/',                             priority: '0.8', changefreq: 'monthly' },
  { loc: '/blog/',                             priority: '0.9', changefreq: 'weekly'  },
  { loc: '/privacy-cookie-policy/',            priority: '0.3', changefreq: 'yearly'  },
  { loc: '/payment-terms-cancellation-policy/', priority: '0.3', changefreq: 'yearly' },
  // /thank-you/ intentionally excluded — noindex conversion page
  // /404/ intentionally excluded — error page
  // /nepal-lp01/ and /india-lp01/ (+ their /thank-you/ pages) intentionally
  //   excluded — noindex paid-campaign landing pages, reached via ads only.
  // /internal/dashboard/ intentionally excluded — Identity-gated internal tool.
  // /account/ intentionally excluded — team sign-in / Identity token handling.
];

// Evergreen pillar pages. These live at the site root (not under /blog/) because they
// are anchor pages we refresh in place each year rather than dated journal entries —
// so they carry an explicit lastmod, and it must be bumped whenever the page's
// "Last reviewed" date changes. Keep the URL stable across annual refreshes; do not
// roll the slug to a new year.
const pillarUrls = [
  { loc: '/bhutan-travel-cost-sdf-2026/',           lastmod: '2026-07-29', priority: '0.9', changefreq: 'yearly' },
  { loc: '/nepal-trekking-permits-2026/',           lastmod: '2026-08-01', priority: '0.9', changefreq: 'yearly' },
  { loc: '/tibet-without-a-permit-amdo-kham-2026/', lastmod: '2026-08-01', priority: '0.9', changefreq: 'yearly' },
  // Ladakh pillar to follow — draft still has open reviewer questions.
];

export const GET: APIRoute = async () => {
  const posts = await getCollection('blog');

  const urls = [
    ...staticUrls,
    ...pillarUrls,
    ...(destinations as any[]).map((d) => ({
      loc:        `/destinations/${d.slug}/`,
      priority:   '0.8',
      changefreq: 'monthly',
    })),
    ...posts.map((p) => ({
      loc:        `/blog/${p.slug}/`,
      lastmod:    p.data.date.toISOString().slice(0, 10),
      priority:   '0.6',
      changefreq: 'monthly',
    })),
  ];

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map((u: any) => {
        const lastmod = u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : '';
        return (
          `  <url>\n` +
          `    <loc>${SITE}${u.loc}</loc>\n` +
          lastmod +
          `    <changefreq>${u.changefreq}</changefreq>\n` +
          `    <priority>${u.priority}</priority>\n` +
          `  </url>`
        );
      })
      .join('\n') +
    `\n</urlset>\n`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
