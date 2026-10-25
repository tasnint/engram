import { defineConfig } from "vitest/config";

const src = (path: string) => new URL(path, import.meta.url).pathname;

/**
 * Integration tests across packages, against a real replica set.
 * - MONGODB_TEST_URI set: use that database. Point it at `pnpm db:up` to include
 *   search tests (they need mongot).
 * - Not set: start a throwaway mongod (needs `mongod` on PATH or MONGOD_BINARY).
 *   Search tests skip, since a plain mongod has no mongot.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@engram/core": src("./packages/core/src/index.ts"),
      "@engram/server": src("./packages/server/src/app.ts"),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["./tests/integration/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
