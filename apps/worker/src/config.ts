import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { PoolConfig } from 'pg';

export interface WorkerConfig {
  pool: PoolConfig;
  stripeApiBase: string;
  reconcileIntervalHours: number;
  reconcileDays: number;
  pollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const ssl = env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined;
  let pool: PoolConfig;
  if (env.WORKER_DATABASE_URL) {
    pool = { connectionString: env.WORKER_DATABASE_URL, ssl, max: 4 };
  } else if (env.DB_HOST && env.WORKER_DB_PASSWORD) {
    pool = {
      host: env.DB_HOST,
      port: Number(env.DB_PORT ?? 5432),
      database: env.DB_NAME ?? 'joybot',
      user: env.WORKER_DB_USER ?? 'joybot_worker',
      password: env.WORKER_DB_PASSWORD,
      ssl,
      max: 4,
    };
  } else {
    throw new Error('WORKER_DATABASE_URL or DB_HOST + WORKER_DB_PASSWORD is required');
  }
  return {
    pool,
    stripeApiBase: env.STRIPE_API_BASE ?? 'https://api.stripe.com',
    reconcileIntervalHours: Number(env.STRIPE_RECONCILE_INTERVAL_HOURS ?? 24),
    reconcileDays: Number(env.STRIPE_RECONCILE_DAYS ?? 3),
    pollIntervalMs: Number(env.STRIPE_POLL_INTERVAL_MS ?? 2000),
  };
}

const secrets = new SecretsManagerClient({});
let keyCache: { value: string | undefined; at: number } | undefined;

/** Restricted (read-only) Stripe key: STRIPE_RESTRICTED_KEY locally, Secrets Manager in AWS. */
export async function stripeRestrictedKey(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.STRIPE_RESTRICTED_KEY) return env.STRIPE_RESTRICTED_KEY;
  if (!env.STRIPE_SECRET_ARN) return undefined;
  if (keyCache && Date.now() - keyCache.at < 5 * 60_000) return keyCache.value;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: env.STRIPE_SECRET_ARN }));
  const value = JSON.parse(res.SecretString ?? '{}').restrictedKey || undefined;
  keyCache = { value, at: Date.now() };
  return value;
}
