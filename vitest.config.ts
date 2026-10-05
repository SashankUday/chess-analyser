import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.engine.test.ts"],
    testTimeout: 20000,
  },
});
