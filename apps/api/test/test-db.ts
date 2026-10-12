/**
 * Test databases. A template (`<db>_test_template`) is migrated and seeded once per run
 * (global-setup.ts); every test file then gets a fresh copy of it in its worker's own database
 * (`<db>_test_<worker>`, reset-db.ts), so files are independent and can run in parallel. The
 * development database named in .env is never touched.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';

export const ENV_FILE = path.resolve(__dirname, '../../../.env');

/** The connection URLs that name a database; tests and the app read them from the environment. */
export const DATABASE_URLS = ['MIGRATOR_DATABASE_URL', 'APP_DATABASE_URL', 'READER_DATABASE_URL', 'WORKER_DATABASE_URL'] as const;

/** .env as written (ignoring any overrides already applied in this process). */
export function envFile(): Record<string, string | undefined> {
  return parse(readFileSync(ENV_FILE));
}

/** The same connection URL, pointed at another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function testDatabases(env = envFile()) {
  const migrator = env.MIGRATOR_DATABASE_URL;
  if (!migrator) throw new Error(`MIGRATOR_DATABASE_URL is not set in ${ENV_FILE}`);
  const base = new URL(migrator).pathname.slice(1) || 'joybot';
  return {
    migrator,
    template: `${base}_test_template`,
    worker: (id: string) => `${base}_test_${id}`,
  };
}

/** Runs statements on the server's maintenance database (CREATE/DROP DATABASE cannot run inside the target). */
export async function onServer(migrator: string, ...statements: string[]): Promise<void> {
  const client = new Client({ connectionString: withDatabase(migrator, 'postgres') });
  await client.connect();
  try {
    for (const sql of statements) await client.query(sql);
  } finally {
    await client.end();
  }
}

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
