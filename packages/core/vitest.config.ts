import { defineConfig } from "vitest/config";

// Integration tests for all packages live in tests/integration at the repo root.
export default defineConfig({
  test: { include: ["test/unit/**/*.test.ts"], restoreMocks: true },
});
