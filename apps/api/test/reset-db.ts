import path from 'node:path';
import { config } from 'dotenv';
import { beforeAll } from 'vitest';
import { bootstrapRoleLogins, migrate, resetDatabase, seedSampleData, seedSettings } from '@joybot/db';

/**
 * Fresh, seeded database before each test file (vitest setupFiles run once per file), so files never
 * depend on what other files changed — and pass in any order.
 */
async function resetDb(): Promise<void> {
  config({ path: path.resolve(__dirname, '../../../.env') });
  const url = process.env.MIGRATOR_DATABASE_URL!;
  await resetDatabase(url);
  await migrate(url, () => undefined);
  await bootstrapRoleLogins(url, {
    joybot_app: process.env.APP_DB_PASSWORD,
    joybot_reader: process.env.READER_DB_PASSWORD,
    joybot_worker: process.env.WORKER_DB_PASSWORD,
  });
  await seedSettings(url, { businessName: 'JoyBot Test', defaultTimeZone: 'America/New_York', defaultCurrency: 'USD' });
  await seedSampleData(url);
}

// Runs before the tests of every file (setupFiles are loaded per test file).
beforeAll(resetDb, 60_000);
