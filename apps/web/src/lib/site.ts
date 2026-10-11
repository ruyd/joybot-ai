import { ApiError } from './api';
import { appConfig } from './config';

/** A page's building blocks (validated by the API: website.schemas.ts). */
export type SiteModule =
  | { id: string; type: 'columns'; heading?: string; columns: SiteColumn[] }
  | { id: string; type: 'html'; html: string }
  | { id: string; type: 'image'; image_id: string; alt: string; caption?: string; size: 'small' | 'medium' | 'full'; link_url?: string }
  | { id: string; type: 'video'; url: string; caption?: string };

export interface SiteColumn {
  heading?: string;
  /** Markdown. */
  text?: string;
  image_id?: string | null;
  image_alt?: string;
  link_label?: string;
  link_url?: string;
}

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
  columns: 'Columns',
  html: 'HTML',
  image: 'Image',
  video: 'Video',
};

export const assetUrl = (id: string) => `${appConfig().apiBase}/site/assets/${id}`;

/** A page's address on the site: "/" for the home page. */
export const pagePath = (p: Pick<SitePageSummary, 'slug' | 'is_home'>) => (p.is_home ? '/' : `/${p.slug}`);

/** The public site's API: no sign-in, so no session headers. */
export async function siteGet<T>(path: string): Promise<T> {
  const res = await fetch(`${appConfig().apiBase}/site${path}`);
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
