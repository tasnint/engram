import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // mongosh scripts run inside the database shell, which provides these globals.
    files: ["docker/**/*.js"],
    languageOptions: {
      globals: {
        rs: "readonly",
        db: "readonly",
        sleep: "readonly",
        print: "readonly",
        require: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
