import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { cacheControl, contentType, siteFiles } from '../src/web-assets/files';

describe('web assets', () => {
  const zip = zipSync({
    'index.html': strToU8('<html></html>'),
    'assets/app-3f2a.js': strToU8('console.log(1)'),
    'config.json': strToU8('{"stale":true}'),
    '.DS_Store': strToU8('x'),
  });

  it('adds a fresh config.json, drops hidden files and the stale config', () => {
    const files = siteFiles(zip, { apiBase: '/api' });
    expect(files.map((f) => f.key).sort()).toEqual(['assets/app-3f2a.js', 'config.json', 'index.html']);
    const config = files.find((f) => f.key === 'config.json')!;
    expect(new TextDecoder().decode(config.body)).toBe('{"apiBase":"/api"}');
    expect(config.cacheControl).toBe('no-cache');
  });

  it('caches hashed assets forever and revalidates HTML', () => {
    expect(cacheControl('assets/app-3f2a.js')).toContain('immutable');
    expect(cacheControl('index.html')).toBe('no-cache');
    expect(contentType('assets/app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentType('logo.svg')).toBe('image/svg+xml');
  });

  it('rejects a zip without index.html', () => {
    expect(() => siteFiles(zipSync({ 'a.js': strToU8('') }), {})).toThrow(/index.html/);
  });
});
