import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { parseGame } from "@chessanalyser/chess-core";
import { WS_PROTOCOL, WS_TOKEN_PREFIX, type ServerEvent } from "@chessanalyser/shared";
import { fixturePgn } from "../../../tests/fixtures";
import { startServer, type RunningServer } from "../src/server";

export interface Harness {
  server: RunningServer;
  dir: string;
  origin: string;
  ui: (path: string, init?: RequestInit & { json?: unknown }) => Promise<Response>;
  mcp: (tool: string, input?: unknown) => Promise<Response>;
  importFixture: (name: string, sourceGameId: string) => string;
  connect: (opts?: { token?: string; origin?: string }) => Promise<UiClient>;
  stop: () => Promise<void>;
}

export interface UiClient {
  ws: WebSocket;
  sessionId: string;
  events: ServerEvent[];
  next: (type: ServerEvent["type"], timeoutMs?: number) => Promise<ServerEvent>;
  state: (gameId: string | null, ply: number | null) => void;
  close: () => void;
}

/** A real ChessAnalyser server on a random loopback port with the deterministic mock engine. */
export async function startHarness(options: { webDir?: string } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-server-"));
  process.env.CHESSANALYSER_DATA_DIR = dir;
  process.env.CHESSANALYSER_ENGINE = "mock";
  process.env.CHESSANALYSER_LOG_FILE = "0";
  process.env.CHESSANALYSER_LOG_LEVEL = "silent";
  const server = await startServer({ webDir: options.webDir });
  await server.ctx.engine.start();
  const origin = server.url;
  const { uiToken, mcpToken } = server.ctx.security;

  const ui: Harness["ui"] = (p, init = {}) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${uiToken}`, ...(init.headers as Record<string, string>) };
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] ??= "application/json";
      headers.Origin ??= origin;
      body = JSON.stringify(init.json);
    }
    return fetch(`${origin}${p}`, { ...init, headers, body });
  };
  const mcp: Harness["mcp"] = (tool, input = {}) =>
    fetch(`${origin}/api/mcp/tools/${tool}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${mcpToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

  const importFixture = (name: string, sourceGameId: string) => {
    const parsed = parseGame(fixturePgn(name));
    const id = server.ctx.db.insertGame(
      {
        profileId: null,
        source: "chesscom",
        sourceGameId,
        url: null,
        white: { username: "alice", rating: 1300 },
        black: { username: "bob", rating: 1300 },
        result: parsed.result,
        playedAt: new Date().toISOString(),
        timeControl: "600",
        timeClass: "rapid",
        eco: null,
        openingName: null,
        variant: parsed.variant,
        supported: parsed.supported,
        userColour: "white",
        pgn: fixturePgn(name),
        startFen: parsed.startFen,
      },
      parsed.moves,
    );
    return id!;
  };

  const connect: Harness["connect"] = (opts = {}) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${opts.token ?? uiToken}`], {
        headers: { Origin: opts.origin ?? origin },
      });
      const events: ServerEvent[] = [];
      const waiters: { type: string; resolve: (e: ServerEvent) => void }[] = [];
      ws.on("message", (raw) => {
        const e = JSON.parse(raw.toString()) as ServerEvent;
        events.push(e);
        for (const w of [...waiters]) {
          if (w.type === e.type) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(e);
          }
        }
        if (e.type === "session.ready") {
          resolve({
            ws,
            sessionId: e.sessionId,
            events,
            next: (type, timeoutMs = 5000) =>
              new Promise((res, rej) => {
                const timer = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs);
                waiters.push({ type, resolve: (ev) => (clearTimeout(timer), res(ev)) });
              }),
            state: (gameId, ply) => ws.send(JSON.stringify({ type: "ui.state", gameId, ply })),
            close: () => ws.close(),
          });
        }
      });
      ws.on("error", reject);
      ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });

  return {
    server,
    dir,
    origin,
    ui,
    mcp,
    importFixture,
    connect,
    stop: async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
