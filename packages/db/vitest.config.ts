import { defineConfig } from 'vitest/config';
import { TEST_ENV } from './test/database';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Its own seeded database (test/database.ts); each test rolls back its own transaction.
    env: TEST_ENV,
    fileParallelism: false,
  },
});
