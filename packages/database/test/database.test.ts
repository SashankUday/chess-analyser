import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineAnalysis } from "@chessanalyser/shared";
import { ChessDb, defaultMigrationsDir, type NewGame } from "../src";

const dirs: string[] = [];
const open: ChessDb[] = [];
function tempDb(): { file: string; db: ChessDb } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-db-"));
  dirs.push(dir);
  const file = path.join(dir, "test.sqlite");
  const db = new ChessDb(file);
  open.push(db);
  return { file, db };
}
afterEach(() => {
  // Windows cannot delete a database file that is still open.
  for (const db of open.splice(0)) db.close();
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
    expect(db.migrations.map((m) => m.version)).toEqual([1, 2]);
    const p = db.upsertProfile("chesscom", "Alice");
    db.insertGame(game("live/1", p.id), []);
    db.close();
    const reopened = new ChessDb(file);
    expect(reopened.migrations).toEqual([]);
    expect(reopened.listGames({ filter: "all", limit: 10, offset: 0 })).toHaveLength(1);
    reopened.close();
  });

  it("upgrades a V1 database without touching existing V1 reviews", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-db-"));
    dirs.push(dir);
    const v1Migrations = path.join(dir, "v1-migrations");
    fs.mkdirSync(v1Migrations);
    fs.copyFileSync(path.join(defaultMigrationsDir(), "001_initial.sql"), path.join(v1Migrations, "001_initial.sql"));
    const file = path.join(dir, "v1.sqlite");
    const v1 = new ChessDb(file, { migrationsDir: v1Migrations });
    const gameId = v1.insertGame(game("live/9", null), [])!;
    const review = {
      gameId, ply: 1, mover: "white" as const, playedMoveSan: "e4", playedMoveUci: "e2e4", classification: "best" as const,
      badges: [], evaluationBefore: { whiteCp: 20, mateForWhiteIn: null }, evaluationAfter: { whiteCp: 20, mateForWhiteIn: null },
      expectedScoreBest: 0.5, expectedScorePlayed: 0.5, expectedScoreLoss: 0, bestMoveSan: "e4", bestMoveUci: "e2e4",
      bestLineId: null, tags: [], explanation: "V1", engine: "Stockfish", engineVersion: "19", algorithmVersion: 1,
      verified: false, reduced: false,
    };
    // Written with the V1 schema, as V1 of ChessAnalyser did.
    v1.db
      .prepare(
        `INSERT INTO move_reviews (id, game_id, ply, mover, played_move_san, played_move_uci, classification, badges_json,
           evaluation_before, evaluation_after, tags_json, explanation, engine, engine_version, algorithm_version, created_at)
         VALUES ('r1', ?, 1, 'white', 'e4', 'e2e4', 'best', '[]', ?, ?, '[]', 'V1', 'Stockfish', '19', 1, '2026-01-01')`,
      )
      .run(gameId, JSON.stringify(review.evaluationBefore), JSON.stringify(review.evaluationAfter));
    v1.close();

    const upgraded = new ChessDb(file);
    expect(upgraded.migrations.map((m) => m.version)).toEqual([2]);
    expect(upgraded.getReviews(gameId)).toMatchObject([{ algorithmVersion: 1, explanation: "V1" }]);
    // A V2 review of the same move is stored alongside, and becomes the one shown.
    upgraded.saveReviews([{ ...review, algorithmVersion: 2, explanation: "V2" }]);
    expect(upgraded.getReviews(gameId)).toMatchObject([{ algorithmVersion: 2, explanation: "V2" }]);
    expect(Number((upgraded.db.prepare("SELECT COUNT(*) AS n FROM move_reviews").get() as { n: number }).n)).toBe(2);
    upgraded.close();
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
