import { unzipSync } from 'fflate';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
  map: 'application/json',
};

export interface SiteFile {
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

export function contentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/** Vite puts content-hashed files under assets/: cache them forever; everything else revalidates. */
export function cacheControl(key: string): string {
  return key.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/** Files from the site zip, plus the runtime config.json (always fresh). */
export function siteFiles(zip: Uint8Array, config: object): SiteFile[] {
  const files = Object.entries(unzipSync(zip))
    .filter(([key]) => !key.endsWith('/') && !key.split('/').some((part) => part === '..' || part.startsWith('.')))
    .filter(([key]) => key !== 'config.json')
    .map(([key, body]) => ({ key, body, contentType: contentType(key), cacheControl: cacheControl(key) }));
  if (!files.some((f) => f.key === 'index.html')) throw new Error('site zip has no index.html');
  files.push({
    key: 'config.json',
    body: new TextEncoder().encode(JSON.stringify(config)),
    contentType: TYPES.json,
    cacheControl: 'no-cache',
  });
  return files;
}
