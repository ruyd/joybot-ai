import path from 'node:path';
import { config } from 'dotenv';
import { bootstrapRoleLogins, migrate, resetDatabase } from '../src/migrate';
import { seedSampleData, seedSettings } from '../src/seed';

/** Fresh, seeded database for every test run (other suites may have changed the data). */
export default async function setup(): Promise<void> {
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
