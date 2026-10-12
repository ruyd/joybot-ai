import { beforeAll } from 'vitest';
import { recreateDatabase, testEnv } from '@joybot/db';
import { envFile, testDatabases } from './test-db';

/**
 * Before each test file (vitest setupFiles run once per file): a fresh copy of the seeded template
 * in this worker's own database, so files never depend on what other files changed, pass in any
 * order, and run in parallel. The database URLs in this process point at that copy; dotenv never
 * overrides variables already set, so tests that load .env themselves get it too.
 */
const env = envFile();
const { migrator, template, worker } = testDatabases(env);
const database = worker(process.env.VITEST_POOL_ID ?? '1');
Object.assign(process.env, testEnv(env, database));

beforeAll(() => recreateDatabase(migrator, database, template), 60_000);
