// `npm run dev`: start the backend, wait until it is healthy, then start the Vite UI (no race on a
// clean start). The backend keeps a fixed port for the whole dev session so restarts don't break
// the Vite proxy.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSessionFile } from "@chessanalyser/shared/node";
import { devUiTokenPath } from "../apps/server/src/server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name: string) => path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
const WEB_PORT = Number(process.env.CHESSANALYSER_WEB_PORT ?? 5173);
const webUrl = `http://127.0.0.1:${WEB_PORT}`;
const children: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}.`);
}

function run(cmd: string, args: string[], env: Record<string, string>, cwd = root): ChildProcess {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit", shell: process.platform === "win32" });
  children.push(child);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`\n${path.basename(cmd)} exited (${code}). Stopping ChessAnalyser.`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main(): Promise<void> {
  console.log("ChessAnalyser\n");
  if (!(await portFree(WEB_PORT))) {
    throw new Error(`Port ${WEB_PORT} is already in use. Stop the other process or set CHESSANALYSER_WEB_PORT.`);
  }
  const apiPort = Number(process.env.CHESSANALYSER_PORT ?? (await freePort()));
  const spawnedAt = new Date().toISOString();
  run(bin("tsx"), ["watch", "--clear-screen=false", "apps/server/src/index.ts"], {
    CHESSANALYSER_DEV: "1",
    CHESSANALYSER_PORT: String(apiPort),
    CHESSANALYSER_DEV_ORIGINS: `${webUrl},http://localhost:${WEB_PORT}`,
  });

  // 1. The backend has written a fresh session file for this run…
  await waitUntil(async () => {
    const s = readSessionFile();
    return !!s && s.port === apiPort && s.startedAt >= spawnedAt && fs.existsSync(devUiTokenPath());
  }, 30_000, "the ChessAnalyser backend to start");
  // 2. …and answers its health check.
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok, 30_000, "the backend health check");

  run(bin("vite"), [], {
    CHESSANALYSER_API_PORT: String(apiPort),
    CHESSANALYSER_DEV_TOKEN_FILE: devUiTokenPath(),
    CHESSANALYSER_WEB_PORT: String(WEB_PORT),
  }, path.join(root, "apps", "web"));
  await waitUntil(async () => (await fetch(webUrl)).ok, 60_000, "the web UI");

  console.log(`\nChessAnalyser running:\n${webUrl}\n`);
  if (process.env.CHESSANALYSER_NO_OPEN !== "1") {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [webUrl], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  }
}

main().catch((err: Error) => {
  console.error(`\n${err.message}`);
  shutdown(1);
});
