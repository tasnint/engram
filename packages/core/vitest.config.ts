import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["test/unit/**/*.test.ts"] },
      },
      {
        // Needs a running database with mongot (pnpm db:up). Skips itself if none is reachable.
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
