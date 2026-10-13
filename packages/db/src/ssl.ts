import { readFileSync } from 'node:fs';

/**
 * TLS to Postgres from the environment, shared by the API, worker and migrations.
 *
 * DB_SSL=true verifies the server certificate. In AWS the RDS bundle comes from NODE_EXTRA_CA_CERTS
 * (baked into the images). Other hosts (Supabase) bring their CA as DB_SSL_CA (PEM text; `\n` escapes
 * are accepted for one-line env vars) or DB_SSL_CA_FILE (a path). Database URLs must not carry
 * `sslmode`, which would override this.
 */
export function sslFromEnv(env: Record<string, string | undefined> = process.env): { rejectUnauthorized: true; ca?: string } | undefined {
  if (env.DB_SSL !== 'true') return undefined;
  const ca = env.DB_SSL_CA ? env.DB_SSL_CA.replace(/\\n/g, '\n') : env.DB_SSL_CA_FILE ? readFileSync(env.DB_SSL_CA_FILE, 'utf8') : undefined;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}
