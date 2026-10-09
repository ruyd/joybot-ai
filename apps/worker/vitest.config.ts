import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@joybot/db': path.resolve(__dirname, '../../packages/db/src/index.ts') } },
  test: { include: ['test/**/*.test.ts'], globalSetup: ['test/global-setup.ts'], fileParallelism: false },
});
