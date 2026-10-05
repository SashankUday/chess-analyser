import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChessDb } from "@chessanalyser/database";
import { APP_VERSION } from "@chessanalyser/shared";
import { dataPaths, ensurePrivateDir, removeSessionFile, writePrivateFile, writeSessionFile } from "@chessanalyser/shared/node";
import { buildApp } from "./app";
import { createContext, type AppContext } from "./context";
import { createLogger } from "./logger";
import { newToken, type SecurityConfig } from "./security";

export interface StartOptions {
  port?: number;
  /** Extra browser origins (the Vite dev server). */
  devOrigins?: string[];
  webDir?: string;
  startEngine?: boolean;
}

export interface RunningServer {
  ctx: AppContext;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/** Locate the built web UI next to the bundled server or in the workspace. */
export function findWebDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "web"), path.resolve(here, "../../web/dist")];
  return candidates.find((d) => fs.existsSync(path.join(d, "index.html")));
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const log = createLogger();
  ensurePrivateDir(dataPaths.root());
  log.info({ version: APP_VERSION, dataDir: dataPaths.root() }, "ChessAnalyser starting");

  const db = new ChessDb(dataPaths.database());
  for (const m of db.migrations) log.info({ migration: m.name }, "Applied database migration");
  log.info("Database ready");

  const security: SecurityConfig = {
    uiToken: newToken(),
    mcpToken: newToken(),
    allowedOrigins: new Set(),
    allowedHosts: new Set(),
  };
  const ctx = createContext({ db, log, security });
  const app = await buildApp(ctx, { webDir: options.webDir });

  // Loopback only — never 0.0.0.0 (spec §39).
  await app.listen({ host: "127.0.0.1", port: options.port ?? Number(process.env.CHESSANALYSER_PORT ?? 0) });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) security.allowedHosts.add(host);
  security.allowedOrigins.add(url).add(`http://localhost:${port}`);
  for (const origin of options.devOrigins ?? []) {
    security.allowedOrigins.add(origin);
    security.allowedHosts.add(new URL(origin).host);
  }

  const startedAt = new Date().toISOString();
  const written = writeSessionFile({ port, token: security.mcpToken, pid: process.pid, startedAt, origin: url });
  if (written.warning) log.warn(written.warning);
  if (options.devOrigins?.length) {
    // Development only: the Vite plugin injects the UI token into index.html from this file.
    writePrivateFile(devUiTokenPath(), JSON.stringify({ token: security.uiToken, port, pid: process.pid, startedAt }));
  }

  if (options.startEngine !== false) void ctx.engine.start();

  const close = async () => {
    ctx.ui.closeAll();
    await app.close();
    await ctx.engine.dispose();
    db.close();
    removeSessionFile(process.pid);
    try {
      fs.unlinkSync(devUiTokenPath());
    } catch {
      // not present
    }
  };
  return { ctx, port, url, close };
}

export function devUiTokenPath(): string {
  return path.join(dataPaths.root(), "dev-ui-session.json");
}
