import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is the web/ folder.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
