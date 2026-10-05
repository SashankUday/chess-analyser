import { defineConfig } from "vitest/config";

// Engine integration tests run a real Stockfish 19 (downloaded on demand).
export default defineConfig({
  test: {
    include: ["packages/engine/test/**/*.engine.test.ts"],
    testTimeout: 300000,
    hookTimeout: 300000,
    fileParallelism: false,
  },
});
