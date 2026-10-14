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

/**
 * Icons for cards, by name: the web app draws them from its own set (lib/site-icons.tsx, the same
 * names), so pages never hold SVG.
 */
export const SITE_ICONS = [
  'sparkles', 'bot', 'brain', 'message-circle', 'shield-check', 'lock', 'users', 'user', 'building', 'store',
  'calendar', 'clock', 'credit-card', 'wallet', 'receipt', 'life-buoy', 'headphones', 'globe', 'layout', 'code',
  'smartphone', 'cloud', 'server', 'palette', 'wrench', 'rocket', 'briefcase', 'check-circle', 'star', 'zap',
  'trending-up', 'heart', 'search', 'file-text', 'map-pin', 'phone', 'mail', 'settings', 'layers', 'puzzle',
  'handshake', 'award', 'target', 'lightbulb', 'compass', 'repeat', 'gift', 'leaf',
] as const;

/**
 * Section options every module has: an anchor for "#links", a background, a small label, a heading
 * (with words to highlight) and an intro.
 */
const section = {
  id: moduleId,
  /** "services" makes the section reachable at /page#services. */
  anchor: z.string().trim().max(40).regex(/^[a-z][a-z0-9-]*$/, 'Use lowercase letters, numbers and dashes, starting with a letter').optional().or(z.literal('')),
  background: z.enum(['default', 'alt', 'dark', 'accent']).optional(),
  /** Where the label, heading and intro sit (centered by default). */
  align: z.enum(['center', 'left']).optional(),
  eyebrow: text(80).optional(),
  /** The label as small capitals (text) or a rounded label in the highlight color (badge). */
  eyebrow_style: z.enum(['text', 'badge']).optional(),
  heading: text(200).optional(),
  /** Words of the heading to highlight (accent color, the heading font's italic); ignored when not in the heading. */
  heading_accent: text(80).optional(),
  /** Markdown. */
  intro: text(2000).optional(),
};

/** A button: by default the first of a pair is drawn filled and the second outlined; style overrides that. */
const button = z.object({ label: text(60).min(1), url: link, style: z.enum(['primary', 'secondary', 'highlight']).optional() }).strict();
const buttons = z.array(button).max(2).optional();

const columnsModule = z
  .object({
    ...section,
    type: z.literal('columns'),
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
  .object({ ...section, type: z.literal('html'), html: z.string().max(100_000).transform(cleanHtml) })
  .strict();

const imageModule = z
  .object({
    ...section,
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
    ...section,
    type: z.literal('video'),
    url: z.string().trim().max(500).refine((u) => videoEmbed(u) !== null, 'Use a YouTube or Vimeo link'),
    caption: text(300).optional(),
  })
  .strict();

/** The top of a page: a label, a large headline (with words to highlight), text and up to two buttons. */
const heroModule = z
  .object({
    ...section,
    type: z.literal('hero'),
    heading: text(200).min(1, 'A hero needs a headline'),
    /** A short rounded label at the start of the hero's label line, e.g. "Open source". */
    badge: text(40).optional(),
    /** Markdown. */
    text: text(2000).optional(),
    buttons,
    image_id: z.string().uuid().nullable().optional(),
    image_alt: text(300).optional(),
  })
  .strict();

/** A grid of up to twelve cards with icons: features, services, steps (numbered) or short points (compact). */
const cardsModule = z
  .object({
    ...section,
    type: z.literal('cards'),
    /** large: roomier cards with headings in the heading font, arrow bullets and button links. */
    variant: z.enum(['cards', 'large', 'numbered', 'compact']).default('cards'),
    /** Cards style: icons above the text, or beside it. */
    icon_position: z.enum(['top', 'side']).default('top'),
    /** Icons in the accent color, or the highlight color. */
    icon_color: z.enum(['accent', 'highlight']).default('accent'),
    /** The buttons under the cards, or beside the heading (left-aligned sections). */
    buttons_position: z.enum(['below', 'header']).default('below'),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
    items: z
      .array(
        z
          .object({
            icon: z.enum(SITE_ICONS).nullable().optional(),
            /** Drawn in the site's highlight color (cards and large cards). */
            highlight: z.boolean().optional(),
            eyebrow: text(80).optional(),
            heading: text(120).optional(),
            /** Markdown: lists work, for bullet points. */
            text: text(4000).optional(),
            image_id: z.string().uuid().nullable().optional(),
            image_alt: text(300).optional(),
            link_label: text(60).optional(),
            link_url: link.optional().or(z.literal('')),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    buttons,
  })
  .strict();

/** Questions and answers, each opening in place. */
const faqModule = z
  .object({
    ...section,
    type: z.literal('faq'),
    items: z
      .array(z.object({ question: text(300).min(1), /** Markdown. */ answer: text(4000) }).strict())
      .min(1)
      .max(30),
  })
  .strict();

/** A closing call to action: heading, text and up to two buttons, on the accent color by default. */
const ctaModule = z
  .object({
    ...section,
    type: z.literal('cta'),
    heading: text(200).min(1, 'A call to action needs a heading'),
    /** Markdown. */
    text: text(2000).optional(),
    buttons,
  })
  .strict();

/** One side of a before-and-after comparison: a label, an optional bar across the top, and chips (a name with a short note). */
const compareSide = z
  .object({
    label: text(80).optional(),
    /** A solid bar above the chips, e.g. "Your core business app + AI". */
    core: text(120).optional(),
    items: z
      .array(z.object({ label: text(60).min(1), /** Small text after the name, e.g. "per seat". */ note: text(40).optional() }).strict())
      .max(16),
  })
  .strict();

/** Before → after: chips in a dashed box, an arrow, then chips in a box in the highlight color. */
const compareModule = z.object({ ...section, type: z.literal('compare'), before: compareSide, after: compareSide }).strict();

export const moduleSchema = z.discriminatedUnion('type', [columnsModule, htmlModule, imageModule, videoModule, heroModule, cardsModule, faqModule, ctaModule, compareModule]);
export type SiteModule = z.infer<typeof moduleSchema>;

const pageFields = {
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes')
    .refine((s) => !['portal', 'staff', 'auth', 'api', 'assets', 'login', 'book-a-call'].includes(s), 'This address is used by the app'),
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
      const anchors = new Set<string>();
      for (const [i, m] of list.entries()) {
        if (seen.has(m.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: 'Module ids must be unique on a page' });
        seen.add(m.id);
        if (m.anchor && anchors.has(m.anchor)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'anchor'], message: 'Anchors must be unique on a page' });
        if (m.anchor) anchors.add(m.anchor);
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

/** Fonts the site can use (bundled with the web app: lib/site-fonts.ts has the same names). */
export const SITE_FONTS = ['system', 'inter', 'dm-sans', 'manrope', 'space-grotesk', 'instrument-serif', 'playfair-display', 'fraunces', 'lora'] as const;

const color = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, 'Use a color like #6d5dfc');

/** Optional text: blank means none. */
const optional = (max: number) =>
  text(max)
    .nullable()
    .transform((v) => v || null);

/** Site setup: how the public site looks and what its header holds. */
export const siteSettingsSchema = z
  .object({
    /** The name the site shows; null means the business name. */
    site_name: optional(80),
    tagline: optional(60),
    logo_asset_id: z.string().uuid().nullable(),
    /** The browser tab icon; null uses the logo. */
    favicon_asset_id: z.string().uuid().nullable(),
    accent: color,
    accent_to: color,
    /** A second brand color for highlighted cards and the hero glow; null means accent_to. */
    highlight_color: color.nullable().or(z.literal('').transform(() => null)),
    heading_font: z.enum(SITE_FONTS),
    body_font: z.enum(SITE_FONTS),
    /** Extra header links after the pages shown in the header: "/#services", "/about", https://… */
    header_links: z.array(z.object({ label: text(40).min(1), url: link }).strict()).max(8),
    /** The header button and its link go together (both or neither). */
    header_button_label: optional(40),
    header_button_url: link.nullable().or(z.literal('').transform(() => null)),
    show_customer_login: z.boolean(),
  })
  .partial()
  .strict();
export type SiteSettingsInput = z.infer<typeof siteSettingsSchema>;
