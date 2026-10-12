import { createSeededDatabase, dropDatabase } from '@joybot/db';
import { DATABASE, ENV } from './database';

/** A fresh, seeded database of its own for every run (the development database is never touched). */
export default async function setup(): Promise<() => Promise<void>> {
  await createSeededDatabase(ENV, DATABASE);
  return () => dropDatabase(ENV.MIGRATOR_DATABASE_URL!, DATABASE);
}
