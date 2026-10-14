import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError } from './api';
import { appConfig } from './config';
import type { SiteFontName } from './site-fonts';
import type { SiteIconName } from './site-icons';

/** Section options every module has (see website.schemas.ts). */
export interface SiteSection {
  id: string;
  /** "services" makes the section reachable at /page#services. */
  anchor?: string;
  background?: SiteBackground;
  /** Where the label, heading and intro sit; centered by default. */
  align?: 'center' | 'left';
  /** A small label above the heading. */
  eyebrow?: string;
  /** Small capitals, or a rounded label in the highlight color. */
  eyebrow_style?: 'text' | 'badge';
  heading?: string;
  /** Words of the heading to highlight; ignored when not in the heading. */
  heading_accent?: string;
  /** Markdown. */
  intro?: string;
}
export type SiteBackground = 'default' | 'alt' | 'dark' | 'accent';

/** The first of a pair is drawn filled, the second outlined. */
export interface SiteButton {
  label: string;
  url: string;
  /** Overrides the default (first filled, second outlined). */
  style?: 'primary' | 'secondary' | 'highlight';
}

/** A page's building blocks (validated by the API: website.schemas.ts). */
export type SiteModule = SiteSection &
  (
    | { type: 'columns'; columns: SiteColumn[] }
    | { type: 'html'; html: string }
    | { type: 'image'; image_id: string; alt: string; caption?: string; size: 'small' | 'medium' | 'full'; link_url?: string }
    | { type: 'video'; url: string; caption?: string }
    | { type: 'hero'; heading: string; badge?: string; text?: string; buttons?: SiteButton[]; image_id?: string | null; image_alt?: string }
    | { type: 'cards'; variant: 'cards' | 'large' | 'numbered' | 'compact'; icon_position?: 'top' | 'side'; icon_color?: 'accent' | 'highlight'; buttons_position?: 'below' | 'header'; columns: 2 | 3 | 4; items: SiteCard[]; buttons?: SiteButton[] }
    | { type: 'faq'; items: { question: string; answer: string }[] }
    | { type: 'cta'; heading: string; text?: string; buttons?: SiteButton[] }
    | { type: 'compare'; before: SiteCompareSide; after: SiteCompareSide }
  );

/** One side of a before-and-after comparison. */
export interface SiteCompareSide {
  label?: string;
  /** A solid bar above the chips. */
  core?: string;
  items: { label: string; note?: string }[];
}
export type SiteModuleOf<T extends SiteModule['type']> = Extract<SiteModule, { type: T }>;

export interface SiteColumn {
  heading?: string;
  /** Markdown. */
  text?: string;
  image_id?: string | null;
  image_alt?: string;
  link_label?: string;
  link_url?: string;
}

export interface SiteCard extends SiteColumn {
  icon?: SiteIconName | null;
  /** Drawn in the site's highlight color. */
  highlight?: boolean;
  eyebrow?: string;
}

/** Site setup (Marketing › Website › Site setup): the site's look and header. */
export interface SiteSettings {
  /** The name the site shows; null means the business name. */
  site_name: string | null;
  tagline: string | null;
  logo_asset_id: string | null;
  /** The browser tab icon; null uses the logo. */
  favicon_asset_id: string | null;
  accent: string;
  accent_to: string;
  /** Highlighted cards and the hero glow; null means accent_to. */
  highlight_color: string | null;
  heading_font: SiteFontName;
  body_font: SiteFontName;
  header_links: { label: string; url: string }[];
  header_button_label: string | null;
  header_button_url: string | null;
  show_customer_login: boolean;
}

/** The look the site has had all along: the app's own blue to teal, system fonts. */
export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  site_name: null,
  tagline: null,
  logo_asset_id: null,
  favicon_asset_id: null,
  accent: '#0878ab',
  accent_to: '#34868f',
  highlight_color: null,
  heading_font: 'system',
  body_font: 'system',
  header_links: [],
  header_button_label: null,
  header_button_url: null,
  show_customer_login: true,
};

export interface SitePageSummary {
  slug: string;
  title: string;
  description: string | null;
  is_home: boolean;
  show_in_header: boolean;
  show_in_footer: boolean;
  sort_order: number;
}

export interface SitePage extends SitePageSummary {
  modules: SiteModule[];
}

export const MODULE_LABEL: Record<SiteModule['type'], string> = {
  hero: 'Hero',
  cards: 'Cards',
  columns: 'Columns',
  html: 'HTML',
  image: 'Image',
  video: 'Video',
  faq: 'FAQ',
  compare: 'Before and after',
  cta: 'Call to action',
};

/**
 * An uploaded image: from the bucket's CDN when the server keeps images there (`assetBase`), else from
 * the API. `storage` (known in the editor's library) keeps images not yet moved to the bucket working.
 */
export function assetUrl(id: string, storage?: 'db' | 's3'): string {
  const { assetBase, apiBase } = appConfig();
  return assetBase && storage !== 'db' ? `${assetBase}/site/${id}` : `${apiBase}/site/assets/${id}`;
}

/**
 * The public site's browser tab icon: Site setup's favicon, else its logo, else the app's own icon
 * (index.html). Put back when leaving the site, so the portal and staff console keep JoyBot's.
 */
export function useSiteFavicon(settings: Pick<SiteSettings, 'favicon_asset_id' | 'logo_asset_id'> | null | undefined) {
  const id = settings?.favicon_asset_id ?? settings?.logo_asset_id ?? null;
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link || !id) return;
    const before = { href: link.getAttribute('href'), type: link.getAttribute('type') };
    link.setAttribute('href', assetUrl(id));
    link.removeAttribute('type');
    return () => {
      if (before.href) link.setAttribute('href', before.href);
      if (before.type) link.setAttribute('type', before.type);
    };
  }, [id]);
}

/** A page's address on the site: "/" for the home page. */
export const pagePath = (p: Pick<SitePageSummary, 'slug' | 'is_home'>) => (p.is_home ? '/' : `/${p.slug}`);

/** The public site's API: no sign-in, so no session headers. */
export async function siteGet<T>(path: string): Promise<T> {
  const res = await fetch(`${appConfig().apiBase}/site${path}`);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export interface SiteInfo {
  /** The site's own name, else the business name. */
  name: string | null;
  business_name: string | null;
  settings: SiteSettings | null;
  pages: SitePageSummary[];
}

/** The public site's name, setup and published pages (header and footer). */
export const useSite = () =>
  useQuery({ queryKey: ['site'], queryFn: () => siteGet<SiteInfo>(''), staleTime: 60_000, retry: retryWhileWaking, retryDelay: wakeDelay });

/**
 * A sleeping API (Render's free plan) can answer 5xx or drop the connection while it wakes: keep
 * trying for about a minute and a half. Other errors (404, 400) are final.
 */
export const retryWhileWaking = (count: number, err: unknown) => {
  const status = (err as { status?: number }).status;
  return count < 8 && (!status || status >= 500);
};
const wakeDelay = (attempt: number) => Math.min(2_000 * 2 ** attempt, 15_000);

/** POST to the public site API (no sign-in), e.g. booking a sales call. */
export async function sitePost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${appConfig().apiBase}/site${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** The embeddable player for a YouTube or Vimeo link (the API only accepts those), or null. */
export function videoEmbed(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '');
  let id: string | null = null;
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    id = u.pathname === '/watch' ? u.searchParams.get('v') : (/^\/(?:embed|shorts)\/([^/]+)/.exec(u.pathname)?.[1] ?? null);
  } else if (host === 'youtu.be') {
    id = u.pathname.slice(1);
  }
  if (id) return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const vimeo = /(\d{6,12})/.exec(u.pathname)?.[1];
    return vimeo ? `https://player.vimeo.com/video/${vimeo}` : null;
  }
  return null;
}
