import path from 'node:path';
import { config } from 'dotenv';
import { bootstrapRoleLogins, migrate, resetDatabase, seedSampleData, seedSettings } from '@joybot/db';

/** Fresh, seeded database for every API test run. */
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
