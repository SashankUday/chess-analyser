import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineAnalysis } from "@chessanalyser/shared";
import { ChessDb, type NewGame } from "../src";

const dirs: string[] = [];
function tempDb(): { file: string; db: ChessDb } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-db-"));
  dirs.push(dir);
  const file = path.join(dir, "test.sqlite");
  return { file, db: new ChessDb(file) };
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const game = (sourceGameId: string, profileId: string | null): NewGame => ({
  profileId,
  source: "chesscom",
  sourceGameId,
  url: `https://www.chess.com/game/live/${sourceGameId}`,
  white: { username: "alice", rating: 1300 },
  black: { username: "bob", rating: 1310 },
  result: "1-0",
  playedAt: "2026-09-01T12:00:00.000Z",
  timeControl: "600",
  timeClass: "rapid",
  eco: "B20",
  openingName: "Sicilian Defence",
  variant: "standard",
  supported: true,
  userColour: "white",
  pgn: "1. e4 *",
  startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
});

describe("ChessDb", () => {
  it("applies migrations once and preserves data on reopen", () => {
    const { file, db } = tempDb();
    expect(db.migrations.map((m) => m.version)).toEqual([1]);
    const p = db.upsertProfile("chesscom", "Alice");
    db.insertGame(game("live/1", p.id), []);
    db.close();
    const reopened = new ChessDb(file);
    expect(reopened.migrations).toEqual([]);
    expect(reopened.listGames({ filter: "all", limit: 10, offset: 0 })).toHaveLength(1);
    reopened.close();
  });

  it("prevents duplicate imports via (source, source_game_id)", () => {
    const { db } = tempDb();
    const p = db.upsertProfile("chesscom", "alice");
    expect(db.upsertProfile("chesscom", "ALICE").id).toBe(p.id);
    expect(db.insertGame(game("live/1", p.id), [])).toBeTypeOf("string");
    expect(db.insertGame(game("live/1", p.id), [])).toBeNull();
  });

  it("filters games by result relative to the profile user", () => {
    const { db } = tempDb();
    const p = db.upsertProfile("chesscom", "alice");
    db.insertGame(game("live/1", p.id), []);
    db.insertGame({ ...game("live/2", p.id), result: "0-1" }, []);
    expect(db.listGames({ filter: "wins", limit: 10, offset: 0 })).toHaveLength(1);
    expect(db.listGames({ filter: "losses", limit: 10, offset: 0 })).toHaveLength(1);
    expect(db.listGames({ filter: "not_analysed", limit: 10, offset: 0 })).toHaveLength(2);
  });

  it("round-trips settings with defaults", () => {
    const { db } = tempDb();
    expect(db.getSettings().palette).toBe("navy");
    expect(db.updateSettings({ palette: "pink" }).palette).toBe("pink");
  });

  it("stores and finds engine analyses by FEN + config hash", () => {
    const { db } = tempDb();
    const a: EngineAnalysis = {
      id: "a1",
      engine: "Stockfish",
      engineVersion: "19",
      capabilities: { wdl: true, multipv: true },
      fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
      preset: "standard",
      configHash: "cfg1",
      nodes: 200000,
      depth: 20,
      evaluation: { whiteCp: 0, mateForWhiteIn: null },
      wdl: { whiteWin: 0, draw: 1, blackWin: 0 },
      lines: [
        {
          id: "l1",
          rank: 1,
          rootMoveUci: "a1a2",
          rootMoveSan: "Ka2",
          evaluation: { whiteCp: 0, mateForWhiteIn: null },
          moves: [{ san: "Ka2", uci: "a1a2", fenAfter: "x" }],
        },
      ],
      createdAt: new Date().toISOString(),
    };
    db.saveAnalysis(a, { nodes: 200000 });
    expect(db.findAnalysis(a.fen, "cfg1")?.lines[0]?.rootMoveSan).toBe("Ka2");
    expect(db.findAnalysis(a.fen, "cfg2")).toBeNull();
    expect(db.getLine("l1")?.fen).toBe(a.fen);
    expect(db.clearEngineCache()).toBe(1);
    expect(db.getLine("l1")).toBeNull();
  });
});
