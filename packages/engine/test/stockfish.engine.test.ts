import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { legalMoves } from "@chessanalyser/chess-core";
import { AbortError, SjengEngine, StockfishEngine, findSjeng, installStockfish, readManagedInstall } from "../src";

// Real-engine tests. Stockfish 19 is installed (downloaded + SHA-256 verified) into a repo-local,
// git-ignored data directory once, then reused.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
process.env.CHESSANALYSER_DATA_DIR ??= path.join(repoRoot, ".data", "engine-tests");

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const opts = { preset: "custom" as const, nodes: 50_000, multiPv: 1 };

let engine: StockfishEngine;

beforeAll(async () => {
  const record = readManagedInstall() ?? (await installStockfish());
  engine = new StockfishEngine(record.binary, { threads: 1, hashMb: 16, isolateSearches: true });
});
afterAll(async () => {
  await engine?.dispose();
});

describe("Stockfish 19", () => {
  it("completes the UCI handshake and identifies itself", async () => {
    const id = await engine.identify();
    expect(id.name).toBe("Stockfish 19");
    expect(id.version).toBe("19");
    expect(id.network).toMatch(/^nn-[0-9a-f]+\.nnue$/);
    expect(id.binarySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a legal best move with WDL that sums to 1", async () => {
    const a = await engine.analysePosition({ fen: START }, opts);
    const legal = legalMoves(START).map((m) => m.lan);
    expect(legal).toContain(a.lines[0]!.rootMoveUci);
    const w = a.wdl!;
    expect(w.whiteWin + w.draw + w.blackWin).toBeCloseTo(1, 5);
    expect(a.evaluation.whiteCp!).toBeGreaterThan(-100);
    expect(a.evaluation.whiteCp!).toBeLessThan(150);
  });

  it("returns three lines with MultiPV 3", async () => {
    const a = await engine.analysePosition({ fen: START }, { ...opts, multiPv: 3 });
    expect(a.lines.map((l) => l.rank)).toEqual([1, 2, 3]);
    expect(new Set(a.lines.map((l) => l.rootMoveUci)).size).toBe(3);
  });

  it("represents mate for either side from White's point of view", async () => {
    const white = await engine.analysePosition({ fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1" }, opts);
    expect(white.evaluation).toEqual({ whiteCp: null, mateForWhiteIn: 1 });
    expect(white.lines[0]!.rootMoveSan).toBe("Ra8#");
    const black = await engine.analysePosition({ fen: "r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1" }, opts);
    expect(black.evaluation.mateForWhiteIn).toBe(-1);
    expect(black.wdl!.blackWin).toBeGreaterThan(0.99);
  });

  it("restricts the root search with searchmoves", async () => {
    const a = await engine.analysePosition({ fen: START }, { ...opts, searchMoves: ["a2a3"] });
    expect(a.lines[0]!.rootMoveUci).toBe("a2a3");
  });

  it("cancels a long search promptly", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const p = engine.analysePosition({ fen: START }, { ...opts, nodes: 500_000_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("recovers after the process is killed", async () => {
    engine.kill();
    await new Promise((r) => setTimeout(r, 100));
    const a = await engine.analysePosition({ fen: START }, opts);
    expect(a.lines.length).toBe(1);
  });
});

describe.skipIf(os.platform() !== "darwin" || !findSjeng())("Apple Chess (Sjeng) fallback", () => {
  it("analyses a position and finds mate in one", async () => {
    const sjeng = new SjengEngine(findSjeng()!, path.join(process.env.CHESSANALYSER_DATA_DIR!, "sjeng-work"));
    try {
      const id = await sjeng.identify();
      expect(id.kind).toBe("sjeng");
      expect(id.capabilities).toEqual({ wdl: false, multipv: false });
      const a = await sjeng.analysePosition(
        { fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1" },
        { preset: "quick", nodes: 0, multiPv: 1, seconds: 1 },
      );
      expect(a.wdl).toBeUndefined();
      expect(a.lines[0]!.moves.length).toBeGreaterThan(0);
      const mate = await sjeng.analysePosition(
        { fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1" },
        { preset: "quick", nodes: 0, multiPv: 1, seconds: 1 },
      );
      expect(mate.lines[0]!.rootMoveUci).toBe("a1a8");
      expect(mate.evaluation.mateForWhiteIn).toBe(1);
    } finally {
      await sjeng.dispose();
    }
  });
});
