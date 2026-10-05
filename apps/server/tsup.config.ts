import fs from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/setup.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  // Workspace packages ship as TypeScript source; bundle them. Native modules stay external.
  noExternal: [/^@chessanalyser\//],
  external: ["better-sqlite3"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  onSuccess: async () => {
    fs.cpSync("../../packages/database/migrations", "dist/migrations", { recursive: true });
  },
});
