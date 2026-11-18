import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, escapeLiteral, type ClientConfig } from 'pg';

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

/** A migration whose first line is this runs outside a transaction, one statement at a time (for CREATE INDEX CONCURRENTLY). */
export const NO_TRANSACTION = '-- migrate: no-transaction';

export interface MigrateOptions {
  /** How long a statement may wait for a lock before the file is retried (default 5 s). */
  lockTimeoutMs?: number;
  /** Tries per file when a lock wait times out (default 5, a few seconds apart). */
  attempts?: number;
}

const LOCK_TIMEOUT = '55P03';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Splits a no-transaction migration into statements at semicolons that end a line. Such files hold
 * plain statements only (no function bodies or DO blocks), so this is enough.
 */
export function statementsOf(sql: string): string[] {
  return sql
    .split(/;[ \t]*(?:--[^\n]*)?\r?\n/)
    .map((s) => s.replace(/^\s*(--[^\n]*\n\s*)*/g, '').trim().replace(/;$/, ''))
    .filter(Boolean);
}

/**
 * Applies pending SQL migrations in order, each in its own transaction (or, with NO_TRANSACTION, one
 * statement at a time). Forward-only, idempotent.
 *
 * Every statement waits at most `lockTimeoutMs` for a lock. A migration queued behind a long query
 * would otherwise hold up every later query on that table (they queue behind its ACCESS EXCLUSIVE
 * request) and take the app down; instead it gives up, rolls back, and tries again shortly.
 */
export async function migrate(
  connectionString: string | ClientConfig,
  log: (msg: string) => void = console.log,
  dir: string = MIGRATIONS_DIR,
  options: MigrateOptions = {},
): Promise<string[]> {
  const lockTimeout = options.lockTimeoutMs ?? 5_000;
  const attempts = options.attempts ?? 5;
  const client = new Client(typeof connectionString === 'string' ? { connectionString } : connectionString);
  await client.connect();
  const applied: string[] = [];
  try {
    // Serialize concurrent migrators (e.g. two deploys), before anything else, so two first runs don't race.
    await client.query('SELECT pg_advisory_lock(727274)');
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
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM public.schema_migrations')).rows.map((r) => r.version),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      for (let attempt = 1; ; attempt++) {
        try {
          if (sql.trimStart().startsWith(NO_TRANSACTION)) await runWithoutTransaction(client, sql, file, lockTimeout);
          else await runInTransaction(client, sql, file, lockTimeout);
          break;
        } catch (err) {
          const waited = (err as { code?: string }).code === LOCK_TIMEOUT;
          if (!waited || attempt >= attempts) throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
          log(`${file}: a table was busy (waited ${lockTimeout} ms for a lock); trying again (${attempt}/${attempts - 1})`);
          await sleep(1_000 * attempt);
        }
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

async function runInTransaction(client: Client, sql: string, file: string, lockTimeout: number) {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.via', 'migration', true), set_config('lock_timeout', $1, true)`, [`${lockTimeout}ms`]);
    await client.query(sql);
    await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [file]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Each statement on its own (CREATE INDEX CONCURRENTLY can't run in a transaction). Write them so they
 * can run again (IF NOT EXISTS): a retry, or a failure halfway, starts the file over.
 */
async function runWithoutTransaction(client: Client, sql: string, file: string, lockTimeout: number) {
  await client.query(`SELECT set_config('app.via', 'migration', false), set_config('lock_timeout', $1, false)`, [`${lockTimeout}ms`]);
  try {
    for (const statement of statementsOf(sql)) await client.query(statement);
    await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [file]);
  } finally {
    await client.query(`RESET lock_timeout; RESET app.via`).catch(() => undefined);
  }
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
