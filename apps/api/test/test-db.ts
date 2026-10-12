/**
 * The API's test databases. A template (`<db>_test_template`) is migrated and seeded once per run
 * (global-setup.ts); every test file then gets a fresh copy of it in its worker's own database
 * (`<db>_test_<n>`, reset-db.ts), so files are independent and run in parallel. The development
 * database named in .env is never touched; other packages' test databases neither.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { testDatabaseName } from '@joybot/db';

export const ENV_FILE = path.resolve(__dirname, '../../../.env');

/** .env as written (ignoring any overrides already applied in this process). */
export function envFile(): Record<string, string | undefined> {
  return parse(readFileSync(ENV_FILE));
}

export function testDatabases(env = envFile()) {
  return {
    migrator: env.MIGRATOR_DATABASE_URL!,
    template: testDatabaseName(env, 'template'),
    /** Worker databases: `<db>_test_<n>`. */
    worker: (id: string) => testDatabaseName(env, id),
  };
}
