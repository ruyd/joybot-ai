import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { openSecret, settingsSecret, sslFromEnv } from '@joybot/db';
import type { Pool, PoolConfig } from 'pg';

export interface WorkerConfig {
  pool: PoolConfig;
  stripeApiBase: string;
  pollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const ssl = sslFromEnv(env);
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
    pollIntervalMs: Number(env.STRIPE_POLL_INTERVAL_MS ?? 2000),
  };
}

/** Settings › Stripe: how often to reconcile on its own (hours) and how many days back. */
export async function reconcileSettings(pool: Pool): Promise<{ intervalHours: number; days: number }> {
  const row = (await pool.query<{ interval_hours: number; days: number }>('SELECT * FROM authz.stripe_reconcile_settings()')).rows[0];
  return { intervalHours: row?.interval_hours ?? 24, days: row?.days ?? 3 };
}

const secrets = new SecretsManagerClient({});
let keyCache: { value: string | undefined; at: number } | undefined;

/**
 * The Stripe key for reconciling (read PaymentIntents and Charges): the one saved in Settings › Stripe
 * (encrypted with SETTINGS_ENCRYPTION_KEY) first, else STRIPE_RESTRICTED_KEY locally or Secrets Manager in AWS.
 */
export async function stripeRestrictedKey(pool: Pool, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const cipher = (await pool.query<{ k: string | null }>('SELECT authz.stripe_key_cipher() AS k')).rows[0]?.k;
  if (cipher) {
    const secret = settingsSecret(env);
    if (!secret) throw new Error('A Stripe key is saved in Settings, but SETTINGS_ENCRYPTION_KEY is not set for the worker');
    return openSecret(cipher, secret);
  }
  if (env.STRIPE_RESTRICTED_KEY) return env.STRIPE_RESTRICTED_KEY;
  if (!env.STRIPE_SECRET_ARN) return undefined;
  if (keyCache && Date.now() - keyCache.at < 5 * 60_000) return keyCache.value;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: env.STRIPE_SECRET_ARN }));
  const value = JSON.parse(res.SecretString ?? '{}').restrictedKey || undefined;
  keyCache = { value, at: Date.now() };
  return value;
}
