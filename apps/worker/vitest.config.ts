import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { TEST_ENV } from './test/database';

export default defineConfig({
  resolve: { alias: { '@joybot/db': path.resolve(__dirname, '../../packages/db/src/index.ts') } },
  // Its own seeded database (test/database.ts), shared by the files one after another.
  test: { include: ['test/**/*.test.ts'], globalSetup: ['test/global-setup.ts'], env: TEST_ENV, fileParallelism: false },
});
