/** Runtime configuration (/config.json, written by the web-assets custom resource in AWS). */
export interface PoolConfig {
  userPoolId: string;
  clientId: string;
  loginDomain: string;
}

export interface AppConfig {
  environment: string;
  apiBase: string;
  /** 'dev' = local sign-in picker with the x-dev-principal header (local API only). */
  authMode?: 'dev' | 'cognito' | 'supabase';
  /** Supabase Auth (authMode 'supabase'): the project URL and its public (anon) key. */
  supabase?: { url: string; anonKey: string };
  region?: string;
  customers?: PoolConfig;
  employees?: PoolConfig;
  appUrl?: string;
  /** Website images in a bucket (SITE_ASSET_STORE=s3): its public address, e.g. https://cdn.example.com. Unset: the API serves them. */
  assetBase?: string;
}

let config: AppConfig | undefined;

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load /config.json');
  const raw = (await res.json()) as AppConfig;
  config = { ...raw, authMode: raw.authMode ?? (raw.supabase ? 'supabase' : raw.customers ? 'cognito' : 'dev') };
  return config;
}

export function appConfig(): AppConfig {
  if (!config) throw new Error('config not loaded');
  return config;
}

/**
 * An absolute URL on the API, for things used outside this page (e.g. the MCP endpoint pasted into
 * Claude): the API's own host when it has one (https://api.example.com/api/…), else this origin
 * (local development and AWS, where the API is under /api on the same host).
 */
export function apiUrl(path: string, origin = window.location.origin): string {
  return new URL(`${appConfig().apiBase.replace(/\/$/, '')}${path}`, origin).href;
}

/** For tests. */
export function setConfig(c: AppConfig): void {
  config = c;
}
