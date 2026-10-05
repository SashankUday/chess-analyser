import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GameReview, JobInfo, ServerEvent, Variation } from "@chessanalyser/shared";
import { startHarness, waitFor, type Harness } from "./harness";

let h: Harness;
let gameA: string;
let gameB: string;

beforeAll(async () => {
  h = await startHarness();
  gameA = h.importFixture("hanging-queen", "live/1");
  gameB = h.importFixture("missed-mate", "live/2");
});
afterAll(async () => {
  await h.stop();
});

async function analyse(gameId: string): Promise<GameReview> {
  const res = await h.ui(`/api/games/${gameId}/analyse`, { method: "POST", json: { preset: "quick" } });
  expect(res.status).toBe(200);
  const job = (await res.json()) as JobInfo;
  await waitFor(async () => {
    const j = (await (await h.ui(`/api/jobs/${job.id}`)).json()) as JobInfo;
    if (j.state === "failed") throw new Error(j.error);
    return j.state === "completed";
  });
  return (await (await h.ui(`/api/games/${gameId}/review`)).json()) as GameReview;
}

describe("local security boundary", () => {
  it("binds to loopback only and is unreachable via the LAN address", async () => {
    expect(h.server.url).toBe(`http://127.0.0.1:${h.server.port}`);
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return; // no LAN interface on this machine
    const outcome = await new Promise<string>((resolve) => {
      const sock = net.connect({ host: lan.address, port: h.server.port });
      sock.once("connect", () => (sock.destroy(), resolve("connected")));
      sock.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    });
    expect(outcome).toBe("ECONNREFUSED");
  });

  it("leaves only /api/health unauthenticated", async () => {
    expect((await fetch(`${h.origin}/api/health`)).status).toBe(200);
    expect((await fetch(`${h.origin}/api/games`)).status).toBe(401);
    expect((await fetch(`${h.origin}/api/settings`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    const mcpTokenOnUi = await fetch(`${h.origin}/api/games`, {
      headers: { Authorization: `Bearer ${h.server.ctx.security.mcpToken}` },
    });
    expect(mcpTokenOnUi.status).toBe(401);
    expect((await h.ui("/api/games")).status).toBe(200);
  });

  it("requires the UI token for mutations, rejects forged origins and wrong content types", async () => {
    const noToken = await fetch(`${h.origin}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: h.origin },
      body: JSON.stringify({ palette: "pink" }),
    });
    expect(noToken.status).toBe(401);
    expect((await h.ui("/api/settings", { method: "PATCH", json: { palette: "pink" }, headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await h.ui("/api/settings", { method: "PATCH", body: "palette=pink", headers: { Origin: h.origin, "Content-Type": "text/plain" } })).status).toBe(415);
    const noOrigin = await fetch(`${h.origin}/api/settings`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${h.server.ctx.security.uiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ palette: "pink" }),
    });
    expect(noOrigin.status).toBe(403);
    const ok = await h.ui("/api/settings", { method: "PATCH", json: { palette: "orange" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { palette: string }).palette).toBe("orange");
  });

  it("refuses CORS preflights and unexpected Host headers", async () => {
    expect((await fetch(`${h.origin}/api/games`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const status = await new Promise<number>((resolve) => {
      http
        .get({ host: "127.0.0.1", port: h.server.port, path: "/api/health", headers: { Host: "attacker.example" } }, (res) =>
          resolve(res.statusCode ?? 0),
        )
        .end();
    });
    expect(status).toBe(403);
  });

  it("authenticates the WebSocket handshake", async () => {
    await expect(h.connect({ token: "0".repeat(64) })).rejects.toThrow(/401/);
    await expect(h.connect({ origin: "https://evil.example" })).rejects.toThrow(/403/);
    const client = await h.connect();
    expect(client.sessionId).toMatch(/[0-9a-f-]{36}/);
    client.close();
  });

  it("keeps the session credential user-private", () => {
    const file = path.join(h.dir, "session.json");
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(session.token).toBe(h.server.ctx.security.mcpToken);
    expect(session.token).not.toBe(h.server.ctx.security.uiToken);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("analysis and review", () => {
  it("analyses a game, stores every position and reviews every move", async () => {
    const review = await analyse(gameA);
    expect(review.complete).toBe(true);
    expect(review.positions).toHaveLength(6);
    expect(review.reviews).toHaveLength(5);
    const qh4 = review.reviews.find((r) => r.playedMoveSan === "Qh4")!;
    expect(qh4.classification).toBe("blunder");
    expect(qh4.algorithmVersion).toBe(2);
    expect(qh4.v2?.metrics.playedRank).toBeNull();
    expect(qh4.tags).toContain("loses_material");
    expect(qh4.explanation).toContain("queen");
  });

  it("serves a second analysis entirely from the cache", async () => {
    const before = h.server.ctx.db.db.prepare("SELECT COUNT(*) AS n FROM engine_analyses").get() as { n: number };
    await analyse(gameA);
    const after = h.server.ctx.db.db.prepare("SELECT COUNT(*) AS n FROM engine_analyses").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("validates candidate moves server-side", async () => {
    const bad = await h.ui(`/api/games/${gameA}/positions/2/candidates`, { method: "POST", json: { move: "Ke3" } });
    expect(bad.status).toBe(422);
    const good = await h.ui(`/api/games/${gameA}/positions/2/candidates`, { method: "POST", json: { move: "g1f3" } });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { move: { san: string } }).move.san).toBe("Nf3");
  });
});

describe("user variations", () => {
  it("creates, extends, truncates and only persists on explicit save", async () => {
    const illegal = await h.ui("/api/variations", { method: "POST", json: { gameId: gameA, startingPly: 2, move: "e5" } });
    expect(illegal.status).toBe(422);
    let res = await h.ui("/api/variations", { method: "POST", json: { gameId: gameA, startingPly: 2, move: "Nf3" } });
    let v = (await res.json()) as Variation;
    expect(v.moves.map((m) => m.san)).toEqual(["Nf3"]);
    res = await h.ui(`/api/variations/${v.id}/moves`, { method: "POST", json: { atIndex: 1, move: "Nc6" } });
    v = (await res.json()) as Variation;
    expect(v.moves.map((m) => m.san)).toEqual(["Nf3", "Nc6"]);
    res = await h.ui(`/api/variations/${v.id}/moves`, { method: "POST", json: { atIndex: 1, move: "d6" } });
    v = (await res.json()) as Variation;
    expect(v.moves.map((m) => m.san)).toEqual(["Nf3", "d6"]);
    expect(h.server.ctx.db.countVariations()).toBe(0);
    await h.ui(`/api/variations/${v.id}/save`, { method: "POST", json: {} });
    expect(h.server.ctx.db.countVariations()).toBe(1);
    // The imported game itself is untouched.
    const moves = (await (await h.ui(`/api/games/${gameA}/moves`)).json()) as { san: string }[];
    expect(moves.map((m) => m.san)).toEqual(["e4", "e5", "Nf3", "Qh4", "Nxh4"]);
  });
});

describe("AI access through the MCP endpoints", () => {
  const setAccess = (json: unknown) => h.ui("/api/ai/access", { method: "POST", json });
  const code = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

  it("rejects chess data while AI access is OFF but reports safe status", async () => {
    await setAccess({ mode: "off" });
    const status = await fetch(`${h.origin}/api/mcp/status`, { headers: { Authorization: `Bearer ${h.server.ctx.security.mcpToken}` } });
    expect(await status.json()).toEqual({ running: true, app: "ChessAnalyser", ai_access: "off" });
    const res = await h.mcp("get_game", { game_id: gameA });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("AI_ACCESS_DENIED");
  });

  it("cannot be enabled through the MCP token", async () => {
    const res = await fetch(`${h.origin}/api/ai/access`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.server.ctx.security.mcpToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "library" }),
    });
    expect(res.status).toBe(401);
  });

  it("scopes CURRENT GAME access to that game and revokes it on game change", async () => {
    const client = await h.connect();
    client.state(gameA, 3);
    await waitFor(async () => h.server.ctx.ui.active()?.gameId === gameA);
    await setAccess({ mode: "current_game", gameId: gameA });
    expect((await h.mcp("get_game", { game_id: gameA })).status).toBe(200);
    expect((await h.mcp("get_game", { game_id: gameB })).status).toBe(403);
    const active = (await (await h.mcp("get_active_game")).json()) as { result: { game_id: string; current_ply: number } };
    expect(active.result).toMatchObject({ game_id: gameA, current_ply: 3 });

    client.state(gameB, 0);
    await client.next("ai.access");
    expect(h.server.ctx.permission.access.mode).toBe("off");
    expect((await h.mcp("get_game", { game_id: gameA })).status).toBe(403);
    client.close();
  });

  it("allows library-wide retrieval in ENTIRE LIBRARY mode", async () => {
    await setAccess({ mode: "library" });
    expect((await h.mcp("get_game", { game_id: gameB })).status).toBe(200);
    const list = (await (await h.mcp("list_games")).json()) as { result: { games: unknown[] } };
    expect(list.result.games.length).toBe(2);
  });

  it("shows only backend-issued lines, ephemerally, and rejects stale or invented ids", async () => {
    const client = await h.connect();
    client.state(gameA, 4);
    await waitFor(async () => h.server.ctx.ui.active()?.id === client.sessionId);
    await setAccess({ mode: "library" });

    const invented = await h.mcp("show_variation", { line_id: "pv_48372" });
    expect(invented.status).toBe(404);
    expect(await code(invented)).toBe("UNKNOWN_LINE");

    const review = (await (await h.mcp("get_move_review", { game_id: gameA, ply: 4 })).json()) as {
      result: { classification: string; best_line: { line_id: string } };
    };
    expect(review.result.classification).toBe("Blunder");
    const lineId = review.result.best_line.line_id;

    const before = h.server.ctx.db.countVariations();
    const shown = h.mcp("show_variation", { line_id: lineId });
    const event = (await client.next("ui.variation.show")) as Extract<ServerEvent, { type: "ui.variation.show" }>;
    expect((await shown).status).toBe(200);
    expect(event.gameId).toBe(gameA);
    expect(event.startingPly).toBe(3);
    expect(h.server.ctx.db.countVariations()).toBe(before);
    expect(h.server.ctx.ui.get(client.sessionId)?.boardMode).toMatchObject({ type: "engineVariation", lineId });

    // Revoking and re-granting access invalidates previously issued lines.
    await setAccess({ mode: "off" });
    await setAccess({ mode: "library" });
    const staleRes = await h.mcp("show_variation", { line_id: lineId });
    expect(staleRes.status).toBe(409);
    expect(await code(staleRes)).toBe("STALE_SESSION");
    client.close();
  });

  it("validates candidates and overlays, and audits every call", async () => {
    const client = await h.connect();
    client.state(gameA, 2);
    await waitFor(async () => h.server.ctx.ui.active()?.id === client.sessionId);
    await setAccess({ mode: "library" });

    const illegal = await h.mcp("analyse_candidate", { game_id: gameA, ply: 2, move: "Kh1" });
    expect(illegal.status).toBe(422);
    expect(await code(illegal)).toBe("ILLEGAL_MOVE");
    const candidate = (await (await h.mcp("analyse_candidate", { game_id: gameA, ply: 2, move: "Nf3" })).json()) as {
      result: { candidate: { san: string }; position_after_candidate: { lines: { line_id: string }[] } };
    };
    expect(candidate.result.candidate.san).toBe("Nf3");
    const shown = h.mcp("show_variation", { line_id: candidate.result.position_after_candidate.lines[0]!.line_id });
    const ev = (await client.next("ui.variation.show")) as Extract<ServerEvent, { type: "ui.variation.show" }>;
    expect(ev.prefix.map((m) => m.san)).toEqual(["Nf3"]);
    expect((await shown).status).toBe(200);

    expect((await h.mcp("highlight_squares", { squares: ["f7", "z9"] })).status).toBe(400);
    expect((await h.mcp("highlight_squares", { squares: ["f7"], role: "rainbow" })).status).toBe(400);
    const arrows = h.mcp("draw_arrows", { arrows: [{ from: "d1", to: "h5", role: "danger" }] });
    expect(await client.next("ui.arrows.draw")).toMatchObject({ arrows: [{ from: "d1", to: "h5", role: "danger" }] });
    expect((await arrows).status).toBe(200);

    await setAccess({ mode: "off" });
    expect((await h.mcp("draw_arrows", { arrows: [{ from: "d1", to: "h5" }] })).status).toBe(403);

    const audit = h.server.ctx.db.listAudit(50);
    expect(audit.some((a) => a.tool === "show_variation" && a.result === "OK")).toBe(true);
    expect(audit.some((a) => a.tool === "draw_arrows" && a.result === "AI_ACCESS_DENIED")).toBe(true);
    client.close();
  });
});

describe("production HTML", () => {
  it("injects the UI token and sends a strict CSP", async () => {
    const webDir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-web-"));
    fs.mkdirSync(path.join(webDir, "assets"));
    fs.writeFileSync(path.join(webDir, "index.html"), '<meta name="chessanalyser-token" content="%CHESSANALYSER_TOKEN%">');
    const saved = process.env.CHESSANALYSER_DATA_DIR;
    const prod = await startHarness({ webDir });
    try {
      const res = await fetch(`${prod.origin}/`);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(await res.text()).toContain(prod.server.ctx.security.uiToken);
    } finally {
      await prod.stop();
      process.env.CHESSANALYSER_DATA_DIR = saved;
      fs.rmSync(webDir, { recursive: true, force: true });
    }
  });
});
