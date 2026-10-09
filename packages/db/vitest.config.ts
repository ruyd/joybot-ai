import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Tests share one seeded database; each test rolls back its own transaction.
    fileParallelism: false,
  },
});
