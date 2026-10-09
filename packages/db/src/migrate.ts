import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, escapeLiteral } from 'pg';

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

/** Applies pending SQL migrations in order, each in its own transaction. Forward-only, idempotent. */
export async function migrate(connectionString: string, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
                          version    text PRIMARY KEY,
                          applied_at timestamptz NOT NULL DEFAULT now())`);
    // Serialize concurrent migrators (e.g. two deploys).
    await client.query('SELECT pg_advisory_lock(727274)');
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM public.schema_migrations')).rows.map((r) => r.version),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
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
 */
export async function bootstrapRoleLogins(
  connectionString: string,
  passwords: Partial<Record<'joybot_app' | 'joybot_reader' | 'joybot_worker', string>>,
): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const [role, password] of Object.entries(passwords)) {
      if (!password) continue;
      await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${escapeLiteral(password)}`);
    }
  } finally {
    await client.end();
  }
}

/** Drops everything (local development and tests only). */
export async function resetDatabase(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS app, core, authz CASCADE;
                        DROP TABLE IF EXISTS public.schema_migrations;`);
  } finally {
    await client.end();
  }
}
