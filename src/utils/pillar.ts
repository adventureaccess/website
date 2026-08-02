/**
 * Shared helpers for the evergreen pillar pages
 * (/bhutan-travel-cost-sdf-2026/, /nepal-trekking-permits-2026/, etc).
 *
 * Pillars differ from blog posts in two ways that matter here:
 *  - They live at the site root and carry no visible post date, so `dateModified`
 *    is their only machine-readable freshness signal. On a page whose value is
 *    being current, that signal is the whole game.
 *  - They are refreshed in place each year rather than replaced, so the review
 *    date has to be a single value feeding both the schema and the visible line.
 *    Two separate strings is how a page ends up telling readers one date and
 *    crawlers another.
 */

export interface Faq {
  q: string;
  a: string;
}

/** Renders an ISO date as e.g. "29 July 2026". UTC-pinned so a build machine in
 *  another timezone cannot shift it by a day. */
export function reviewedOn(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** FAQPage JSON-LD. Always build this from the SAME array that renders the
 *  accordion — if the two drift, the rich result silently misrepresents the page. */
export function faqSchema(faqs: Faq[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

export interface ArticleSchemaInput {
  title: string;
  description: string;
  /** Site-root-relative, e.g. '/nepal-trekking-permits-2026/' */
  path: string;
  /** Site-root-relative hero image */
  image: string;
  reviewedIso: string;
  site: URL | string | undefined;
  /** Entities the page is *about*. sameAs a Wikipedia URI where one exists —
   *  models otherwise resolve these from bare strings. */
  about?: object[];
  /** Entities merely mentioned. */
  mentions?: object[];
  /** Defaults to the org. Prefer a named Person: attributing decades of guiding
   *  experience to a logo is weaker than attributing it to someone. */
  authorName?: string;
}

export function articleSchema(i: ArticleSchemaInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: i.title,
    description: i.description,
    image: new URL(i.image, i.site).toString(),
    datePublished: i.reviewedIso,
    dateModified: i.reviewedIso,
    inLanguage: 'en',
    author: {
      '@type': 'Person',
      name: i.authorName ?? 'Will Buie',
      worksFor: { '@type': 'Organization', name: 'Adventure Access' },
    },
    publisher: { '@type': 'Organization', name: 'Adventure Access' },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': new URL(i.path, i.site).toString(),
    },
    ...(i.about ? { about: i.about } : {}),
    ...(i.mentions ? { mentions: i.mentions } : {}),
  };
}
