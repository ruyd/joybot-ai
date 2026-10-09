import path from 'node:path';
import { config } from 'dotenv';
import { bootstrapRoleLogins, migrate, resetDatabase } from './migrate';
import { seedSampleData, seedSettings } from './seed';

config({ path: path.resolve(__dirname, '../../../.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (copy .env.example to .env)`);
  return value;
}

async function main(command: string | undefined): Promise<void> {
  const url = required('MIGRATOR_DATABASE_URL');
  const setup = async () => {
    await migrate(url);
    await bootstrapRoleLogins(url, {
      joybot_app: process.env.APP_DB_PASSWORD,
      joybot_reader: process.env.READER_DB_PASSWORD,
      joybot_worker: process.env.WORKER_DB_PASSWORD,
    });
    await seedSettings(url, {
      businessName: process.env.BUSINESS_NAME ?? 'JoyBot Demo',
      defaultTimeZone: process.env.DEFAULT_TIME_ZONE ?? 'America/New_York',
      defaultCurrency: process.env.DEFAULT_CURRENCY ?? 'USD',
    });
  };

  switch (command) {
    case 'migrate':
      await setup();
      break;
    case 'seed':
      await setup();
      await seedSampleData(url);
      console.log('sample data seeded');
      break;
    case 'reset':
      await resetDatabase(url);
      await setup();
      await seedSampleData(url);
      console.log('database reset and seeded');
      break;
    default:
      throw new Error('usage: cli.ts migrate | seed | reset');
  }
}

main(process.argv[2]).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
