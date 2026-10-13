import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, escapeLiteral, type ClientConfig } from 'pg';

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

/** Applies pending SQL migrations in order, each in its own transaction. Forward-only, idempotent. */
export async function migrate(
  connectionString: string | ClientConfig,
  log: (msg: string) => void = console.log,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const client = new Client(typeof connectionString === 'string' ? { connectionString } : connectionString);
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
                          version    text PRIMARY KEY,
                          applied_at timestamptz NOT NULL DEFAULT now())`);
    // Only the migrator reads this. Hosts that grant new public tables to API roles (Supabase's anon
    // and authenticated) would otherwise expose it: revoke those grants and deny by RLS (no policies).
    await client.query(`ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
                        REVOKE ALL ON public.schema_migrations FROM PUBLIC;
                        DO $$
                        DECLARE r text;
                        BEGIN
                          FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
                            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
                              EXECUTE format('REVOKE ALL ON public.schema_migrations FROM %I', r);
                            END IF;
                          END LOOP;
                        END $$`);
    // Serialize concurrent migrators (e.g. two deploys).
    await client.query('SELECT pg_advisory_lock(727274)');
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM public.schema_migrations')).rows.map((r) => r.version),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.via', 'migration', true)`);
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    await client.query('SELECT pg_advisory_unlock(727274)');
  } finally {
    await client.end();
  }
  return applied;
}

/**
 * Gives the NOLOGIN app roles a login + password. In AWS the DB bootstrap custom resource does
 * this with passwords from Secrets Manager; locally they come from .env.
 *
 * `onlyFirstTime` leaves roles that can already log in alone: setting a password again (even the same
 * one) makes poolers that cache credentials (Supabase's) refuse that role for a while. Returns the roles
 * whose password was set.
 */
export async function bootstrapRoleLogins(
  connectionString: string | ClientConfig,
  passwords: Partial<Record<'joybot_app' | 'joybot_reader' | 'joybot_worker', string>>,
  options: { onlyFirstTime?: boolean } = {},
): Promise<string[]> {
  const client = new Client(typeof connectionString === 'string' ? { connectionString } : connectionString);
  await client.connect();
  const set: string[] = [];
  try {
    for (const [role, password] of Object.entries(passwords)) {
      if (!password) continue;
      if (options.onlyFirstTime && (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1 AND rolcanlogin', [role])).rowCount) continue;
      await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${escapeLiteral(password)}`);
      set.push(role);
    }
  } finally {
    await client.end();
  }
  return set;
}

/** Drops everything (local development and tests only). */
export async function resetDatabase(connectionString: string | ClientConfig): Promise<void> {
  const client = new Client(typeof connectionString === 'string' ? { connectionString } : connectionString);
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS app, core, authz CASCADE;
                        DROP TABLE IF EXISTS public.schema_migrations;`);
  } finally {
    await client.end();
  }
}
