import fs from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const TOKEN_PLACEHOLDER = "%CHESSANALYSER_TOKEN%";

/**
 * Development only: inject the backend's per-start UI token into index.html. The token file is written
 * by the backend (mode 0600) and its path is passed in by `npm run dev`. Production builds keep the
 * placeholder; the backend substitutes it when serving the page.
 */
function devToken(): Plugin {
  return {
    name: "chessanalyser-dev-token",
    apply: "serve",
    transformIndexHtml(html) {
      const file = process.env.CHESSANALYSER_DEV_TOKEN_FILE;
      if (!file) return html;
      try {
        const { token } = JSON.parse(fs.readFileSync(file, "utf8")) as { token: string };
        return html.replace(TOKEN_PLACEHOLDER, token);
      } catch {
        return html;
      }
    },
  };
}

const apiPort = process.env.CHESSANALYSER_API_PORT;

export default defineConfig({
  plugins: [react(), devToken()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.CHESSANALYSER_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: apiPort
      ? {
          "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
          "/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true, changeOrigin: false },
        }
      : undefined,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
