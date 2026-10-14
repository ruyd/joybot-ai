import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfig } from '../src/lib/config';
import { useSiteFavicon } from '../src/lib/site';

const link = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;

beforeEach(() => {
  setConfig({ environment: 'production', apiBase: 'https://api.example.com/api', assetBase: 'https://cdn.example.com' });
  document.head.innerHTML = '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />';
});
afterEach(cleanup);

describe('useSiteFavicon', () => {
  it('shows the favicon, else the logo, and puts the app icon back when leaving the site', () => {
    type Ids = { favicon_asset_id: string | null; logo_asset_id: string | null };
    const initialProps: Ids = { favicon_asset_id: null, logo_asset_id: 'logo-1' };
    const { rerender, unmount } = renderHook((s: Ids) => useSiteFavicon(s), { initialProps });
    expect(link().getAttribute('href')).toBe('https://cdn.example.com/site/logo-1');
    expect(link().hasAttribute('type')).toBe(false);
    rerender({ favicon_asset_id: 'icon-1', logo_asset_id: 'logo-1' });
    expect(link().getAttribute('href')).toBe('https://cdn.example.com/site/icon-1');
    unmount();
    expect(link().getAttribute('href')).toBe('/favicon.svg');
    expect(link().getAttribute('type')).toBe('image/svg+xml');
  });

  it('keeps the app icon when the site has neither', () => {
    renderHook(() => useSiteFavicon({ favicon_asset_id: null, logo_asset_id: null }));
    expect(link().getAttribute('href')).toBe('/favicon.svg');
  });
});
