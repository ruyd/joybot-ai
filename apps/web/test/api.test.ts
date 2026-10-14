import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/lib/api';
import { setConfig } from '../src/lib/config';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('createApi', () => {
  setConfig({ environment: 'local', apiBase: '/api' });

  it('renews an expired token and retries instead of signing out', async () => {
    let token = 'old';
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).authorization === 'Bearer new' ? json(200, { ok: true }) : json(401, { message: 'Unauthorized' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const signOut = vi.fn(async () => {});
    const api = createApi({
      headers: async () => ({ authorization: `Bearer ${token}` }),
      refresh: async () => ((token = 'new'), true),
      signOut,
    });
    await expect(api.get('/me')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('signs out with the API’s reason when the session cannot be renewed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { message: 'No staff account uses this email' })));
    const signOut = vi.fn(async () => {});
    const api = createApi({ headers: async () => ({}), refresh: async () => false, signOut });
    await expect(api.get('/me')).rejects.toMatchObject({ status: 401 });
    expect(signOut).toHaveBeenCalledWith('No staff account uses this email');
  });
});
