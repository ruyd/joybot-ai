import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfig } from '../src/lib/config';
import { reportView, resetArrival } from '../src/lib/site';

const sent = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

describe('reportView', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setConfig({ environment: 'local', apiBase: '/api' });
    resetArrival();
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends where the visit came from on its first page only', () => {
    reportView('/', { search: '?utm_source=newsletter', referrer: 'https://www.google.com/' });
    reportView('/about', { search: '', referrer: 'https://www.google.com/' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/site/view');
    expect(sent(fetchMock)).toEqual([{ path: '/', referrer: 'https://www.google.com/', utm_source: 'newsletter' }, { path: '/about' }]);
  });

  it('skips automated browsers', () => {
    vi.stubGlobal('navigator', { ...navigator, webdriver: true });
    reportView('/');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
