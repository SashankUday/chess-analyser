import { exec } from "node:child_process";
import { findWebDir, startServer } from "./server";

const dev = process.env.CHESSANALYSER_DEV === "1";
const devOrigins = (process.env.CHESSANALYSER_DEV_ORIGINS ?? "").split(",").filter(Boolean);
const webDir = dev ? undefined : findWebDir();

const server = await startServer({ devOrigins: dev ? devOrigins : [], webDir });
server.ctx.log.info(`ChessAnalyser API listening on ${server.url}`);

if (!dev) {
  if (!webDir) {
    server.ctx.log.warn("Web UI not built. Run `npm run build` first, or use `npm run dev`.");
  } else {
    console.log(`\nChessAnalyser running:\n${server.url}\n`);
    if (process.env.CHESSANALYSER_NO_OPEN !== "1") openBrowser(server.url);
  }
}

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.ctx.log.info("Shutting down");
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  exec(`${cmd} "${url}"`, () => undefined);
}
