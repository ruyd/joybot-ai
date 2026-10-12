import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { testDatabaseName, testEnv } from '@joybot/db';

/** This suite's own database (`<db>_test_worker`), seeded once per run; .env as written. */
export const ENV = parse(readFileSync(path.resolve(__dirname, '../../../.env')));
export const DATABASE = testDatabaseName(ENV, 'worker');
/** The test run's database URLs, pointed at it (dotenv never overrides them). */
export const TEST_ENV = testEnv(ENV, DATABASE);
