import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';

/**
 * HTML from editors is shown to every visitor on the same origin as the portal, so it is reduced to
 * plain structure on save: no scripts, styles, event handlers, iframes or forms; links and images only
 * to http(s), mailto/tel or this site.
 */
export function cleanHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li',
      'blockquote', 'code', 'pre', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'figure', 'figcaption',
    ],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'width', 'height'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https'] },
    allowProtocolRelative: false,
    transformTags: {
      // rel is ours: a link opening a new tab cannot reach back into this page.
      a: (tagName, attribs) => {
        const { rel: _rel, ...rest } = attribs;
        return { tagName, attribs: rest.target === '_blank' ? { ...rest, rel: 'noopener noreferrer' } : rest };
      },
      // Images from https or this site's uploads only (relative paths could point anywhere on this origin).
      img: (tagName, attribs) => {
        const { src, ...rest } = attribs;
        return { tagName, attribs: src && /^(https:\/\/|\/api\/site\/assets\/[0-9a-f-]{36}$)/.test(src) ? { ...rest, src } : rest };
      },
    },
  });
}

/** The embeddable player for a YouTube or Vimeo link, or null when it is neither. */
export function videoEmbed(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '');
  const youtube = /^[A-Za-z0-9_-]{11}$/;
  let id: string | null = null;
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    id = u.pathname === '/watch' ? u.searchParams.get('v') : (/^\/(?:embed|shorts)\/([^/]+)/.exec(u.pathname)?.[1] ?? null);
  } else if (host === 'youtu.be') {
    id = u.pathname.slice(1);
  }
  if (id) return youtube.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const vimeo = /(\d{6,12})/.exec(u.pathname)?.[1];
    return vimeo ? `https://player.vimeo.com/video/${vimeo}` : null;
  }
  return null;
}

const moduleId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const text = (max: number) => z.string().trim().max(max);
const link = z
  .string()
  .trim()
  .max(500)
  .regex(/^(https?:\/\/|\/(?!\/)|mailto:|tel:|#)/, 'Links start with https://, /, mailto:, tel: or #');

const columnsModule = z
  .object({
    id: moduleId,
    type: z.literal('columns'),
    heading: text(200).optional(),
    columns: z
      .array(
        z
          .object({
            heading: text(120).optional(),
            /** Markdown. */
            text: text(4000).optional(),
            image_id: z.string().uuid().nullable().optional(),
            image_alt: text(300).optional(),
            link_label: text(60).optional(),
            link_url: link.optional().or(z.literal('')),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();

const htmlModule = z
  .object({ id: moduleId, type: z.literal('html'), html: z.string().max(100_000).transform(cleanHtml) })
  .strict();

const imageModule = z
  .object({
    id: moduleId,
    type: z.literal('image'),
    image_id: z.string().uuid('Choose an image'),
    alt: text(300).default(''),
    caption: text(300).optional(),
    size: z.enum(['small', 'medium', 'full']).default('full'),
    link_url: link.optional().or(z.literal('')),
  })
  .strict();

const videoModule = z
  .object({
    id: moduleId,
    type: z.literal('video'),
    url: z.string().trim().max(500).refine((u) => videoEmbed(u) !== null, 'Use a YouTube or Vimeo link'),
    caption: text(300).optional(),
  })
  .strict();

export const moduleSchema = z.discriminatedUnion('type', [columnsModule, htmlModule, imageModule, videoModule]);
export type SiteModule = z.infer<typeof moduleSchema>;

const pageFields = {
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes')
    .refine((s) => !['portal', 'staff', 'auth', 'api', 'assets', 'login'].includes(s), 'This address is used by the app'),
  title: text(120).min(1),
  description: text(300).nullable(),
  published: z.boolean(),
  show_in_header: z.boolean(),
  show_in_footer: z.boolean(),
  sort_order: z.number().int().min(-1000).max(1000),
  modules: z
    .array(moduleSchema)
    .max(60)
    .superRefine((list, ctx) => {
      const seen = new Set<string>();
      for (const [i, m] of list.entries()) {
        if (seen.has(m.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: 'Module ids must be unique on a page' });
        seen.add(m.id);
      }
    }),
};

export const createPageSchema = z
  .object(pageFields)
  .partial()
  .required({ slug: true, title: true })
  .strict();

export const updatePageSchema = z
  .object({ ...pageFields, /** Makes this the home page (the current one stops being it). */ is_home: z.literal(true) })
  .partial()
  .strict();
