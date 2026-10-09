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
  authMode?: 'dev' | 'cognito';
  region?: string;
  customers?: PoolConfig;
  employees?: PoolConfig;
  appUrl?: string;
}

let config: AppConfig | undefined;

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load /config.json');
  const raw = (await res.json()) as AppConfig;
  config = { ...raw, authMode: raw.authMode ?? (raw.customers ? 'cognito' : 'dev') };
  return config;
}

export function appConfig(): AppConfig {
  if (!config) throw new Error('config not loaded');
  return config;
}

/** For tests. */
export function setConfig(c: AppConfig): void {
  config = c;
}
