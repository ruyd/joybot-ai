import { useMemo } from 'react';
import { appConfig } from './config';
import { useSession, type Session } from './auth';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { message?: string | string[]; code?: string; issues?: { path: string; message: string }[]; [k: string]: unknown },
  ) {
    super(Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? `Request failed (${status})`));
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
  /** Raw fetch with auth (used for server-sent events). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export function createApi(session: Pick<Session, 'headers' | 'signOut'>): Api {
  const base = appConfig().apiBase;
  const raw = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...session.headers(), ...(init.headers ?? {}) } });

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await raw(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      void session.signOut();
      throw new ApiError(401, { message: 'Your session has ended. Please sign in again.' });
    }
    if (res.status === 204) return undefined as T;
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
    if (!res.ok) throw new ApiError(res.status, data);
    return data as T;
  }

  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    put: (p, b) => call('PUT', p, b ?? {}),
    del: (p) => call('DELETE', p),
    fetch: raw,
  };
}

export function useApi(): Api {
  const session = useSession();
  return useMemo(() => createApi(session), [session]);
}
