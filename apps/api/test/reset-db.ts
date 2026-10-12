import { beforeAll } from 'vitest';
import { DATABASE_URLS, envFile, onServer, quoteIdent, testDatabases, withDatabase } from './test-db';

/**
 * Before each test file (vitest setupFiles run once per file): a fresh copy of the seeded template
 * in this worker's own database, so files never depend on what other files changed, pass in any
 * order, and run in parallel. The database URLs in this process point at that copy; dotenv never
 * overrides variables already set, so tests that load .env themselves get it too.
 */
const env = envFile();
const { migrator, template, worker } = testDatabases(env);
const database = worker(process.env.VITEST_POOL_ID ?? '1');
for (const name of DATABASE_URLS) {
  const url = env[name];
  if (url) process.env[name] = withDatabase(url, database);
}

beforeAll(async () => {
  await onServer(migrator, `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`, `CREATE DATABASE ${quoteIdent(database)} TEMPLATE ${quoteIdent(template)}`);
}, 60_000);
