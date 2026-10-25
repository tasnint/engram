import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@engram/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['./tests/integration/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
