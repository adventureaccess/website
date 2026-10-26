import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    /**
     * Optional SEO <title>. When set it is used verbatim, instead of the default
     * `{title} — AA Journal`. Use it when the approved copy specifies a title tag
     * that differs from the on-page H1 (as trip dispatches usually do).
     */
    seo_title: z.string().optional(),
    date: z.coerce.date(),
    /** Shown in blog cards and used as the SEO meta description. Max 155 chars. */
    excerpt: z.string().optional(),
    /** Path to the hero/featured image, e.g. /images/2025/11/my-photo.jpg */
    featured_image: z.string().optional(),
    /**
     * Optionally links this post to a destination page.
     * When set, a contextual CTA block is rendered below the article
     * pointing readers to /destinations/{destination}.
     */
    destination: z.enum(['ladakh', 'nepal', 'bhutan', 'yunnan']).optional(),
    /** Optional photo gallery shown at the bottom of the post. */
    gallery: z.array(z.string()).optional(),
  }),
});

/* ─────────────────────────── Trips (YouLi replacement, Phase 1) ───────────────────────────
 * One JSON file per trip in src/content/trips/. The file name is the slug.
 * The blocks follow Brian's itinerary framework (hero, stats, route bar, day types,
 * chapters, highlights, good to know, stays, next steps) plus the commercial blocks
 * YouLi has and the framework lacked: pricing, included, excluded.
 *
 * Visibility decides where a trip can be rendered:
 *   internal  → only under /internal/trips/ (behind Google sign-in)
 *   unlisted  → later: a token URL for a named client, noindex
 *   public    → later: /trips/<slug>, indexed
 * Phase 1 renders every trip under /internal/trips/ only.
 */
const image = z.string().startsWith('/images/', { message: 'Images must be re-hosted under /images/, never hot-linked' });
const photo = z.object({ src: image, alt: z.string().min(3) });

const track = z.object({ name: z.string(), text: z.string() });
const day = z
  .object({
    label: z.string(),
    text: z.string().optional(),
    tracks: z.array(track).optional(),
  })
  .refine((d) => d.text || d.tracks, { message: 'A day needs text or tracks' });

const trips = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    status: z.enum(['draft', 'review', 'approved', 'archived']),
    visibility: z.enum(['internal', 'unlisted', 'public']),
    destination: z.enum(['ladakh', 'nepal', 'bhutan', 'yunnan']),
    /** template = the reusable trip; instance = a version for a named client or departure */
    kind: z.enum(['template', 'instance']).default('template'),
    preparedFor: z.string().optional(),
    source: z
      .object({
        youli: z.string().url().optional(),
        migratedOn: z.string().optional(),
        notes: z.string().optional(),
      })
      .optional(),
    seo: z.object({ title: z.string(), description: z.string().max(160) }),
    hero: z.object({
      eyebrow: z.string(),
      title: z.string(),
      titleEm: z.string().optional(),
      subtitle: z.string(),
      image,
      imageAlt: z.string(),
      meta: z.array(z.object({ label: z.string(), value: z.string() })).max(4),
    }),
    intro: z.object({ label: z.string(), heading: z.string(), paragraphs: z.array(z.string()).min(1) }),
    stats: z.array(z.object({ value: z.string(), label: z.string() })).max(5).default([]),
    route: z.array(z.object({ name: z.string(), days: z.string() })).default([]),
    photoStrips: z.array(z.array(photo).length(4)).max(3).default([]),
    dayTypes: z
      .object({
        label: z.string(),
        heading: z.string(),
        lede: z.string(),
        cards: z.array(z.object({ title: z.string(), body: z.string(), tone: z.enum(['strong', 'gentle']).default('strong') })),
      })
      .optional(),
    chapters: z.object({
      label: z.string(),
      heading: z.string(),
      lede: z.string().optional(),
      groups: z
        .array(
          z.object({
            dayStart: z.number().int().positive(),
            dayEnd: z.number().int().positive(),
            title: z.string(),
            tags: z.array(z.string()).default([]),
            badge: z.string().optional(),
            prose: z.array(z.string()).default([]),
            days: z.array(day).min(1),
            overnight: z.string().optional(),
          })
        )
        .min(1),
    }),
    pullQuote: z.string().optional(),
    highlights: z
      .array(z.object({ where: z.string(), title: z.string(), body: z.string(), image, imageAlt: z.string() }))
      .max(6)
      .default([]),
    goodToKnow: z
      .object({
        label: z.string(),
        heading: z.string(),
        lede: z.string().optional(),
        cards: z.array(z.object({ title: z.string(), body: z.string() })),
      })
      .optional(),
    stays: z
      .object({ label: z.string(), heading: z.string(), paragraphs: z.array(z.string()), tags: z.array(z.string()).default([]) })
      .optional(),
    /** Optional on purpose: proposals and previews often have no price yet. Never invent one. */
    pricing: z
      .object({
        from: z.number().positive(),
        currency: z.literal('USD'),
        basis: z.string(),
        notes: z.array(z.string()).default([]),
      })
      .optional(),
    included: z.array(z.string()).default([]),
    excluded: z.array(z.string()).default([]),
    nextSteps: z.object({
      label: z.string(),
      heading: z.string(),
      lede: z.string(),
      steps: z.array(z.object({ title: z.string(), body: z.string() })).max(4),
      cta: z.object({ label: z.string(), href: z.string() }),
      secondary: z.object({ label: z.string(), href: z.string() }).optional(),
    }),
    footerNote: z.array(z.string()).default([]),
  }),
});

export const collections = { blog, trips };
