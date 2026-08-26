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

export const collections = { blog };
