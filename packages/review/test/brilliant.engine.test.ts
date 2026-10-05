// Brilliant / Great regression suite against real Stockfish 19 (V2 plan §23). Run with `npm run test:engine`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uciLineToMoves } from "@chessanalyser/chess-core";
import type { GameMove } from "@chessanalyser/shared";
import { StockfishEngine, installStockfish, readManagedInstall } from "../../engine/src";
import { reviewMoveV2, type ReviewEngine } from "../src";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
process.env.CHESSANALYSER_DATA_DIR ??= path.join(repoRoot, ".data", "engine-tests");

let sf: StockfishEngine;
let eng: ReviewEngine;
const search = (fen: string, nodes: number, multiPv: number, searchMoves?: string[]) =>
  sf.analysePosition({ fen }, { preset: "custom", nodes, multiPv, searchMoves });

beforeAll(async () => {
  const record = readManagedInstall() ?? (await installStockfish());
  sf = new StockfishEngine(record.binary, { threads: 1, hashMb: 64, isolateSearches: true });
  eng = {
    restricted: (fen, uci, deep) => search(fen, deep ? 1_000_000 : 300_000, 1, [uci]),
    deepRoot: (fen) => search(fen, 1_000_000, 3),
    probe: (fen) => search(fen, 50_000, 1),
  };
});
afterAll(async () => {
  await sf?.dispose();
});

async function classify(fen: string, uci: string, previousUci?: string) {
  const root = await search(fen, 300_000, 3);
  const m = uciLineToMoves(fen, [uci])[0]!;
  const move: GameMove = { gameId: "g", ply: 21, san: m.san, uci: m.uci, fenBefore: fen, fenAfter: m.fenAfter };
  const previousMove = previousUci ? { gameId: "g", ply: 20, san: `x${previousUci.slice(2)}`, uci: previousUci, fenBefore: "", fenAfter: fen } : null;
  return reviewMoveV2({
    gameId: "g",
    move,
    previousMove,
    root,
    after: root,
    previousRoot: null,
    engine: eng,
    engineConfig: { engine: "Stockfish 19", version: "19", nodes: 300_000, verificationNodes: 1_000_000, multiPv: 3 },
  });
}

describe("Brilliant: positive cases", () => {
  it("classic Greek gift Bxh7+", async () => {
    const r = await classify("r1bq1rk1/pp1nbppp/2n1p3/2ppP3/3P3P/2PB1N2/PP3PP1/RNBQK2R w KQ - 1 9", "d3h7");
    expect(r.classification).toBe("brilliant");
  });

  it("queen sacrifice for smothered mate (Philidor's legacy) Qg8+", async () => {
    const r = await classify("r6k/6pp/7N/8/2Q5/8/8/6K1 w - - 0 1", "c4g8");
    expect(r.classification).toBe("brilliant");
  });

  it("Légal's sacrifice Nxe5", async () => {
    const r = await classify("rn1qkbnr/ppp2p1p/3p2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5", "f3e5");
    expect(r.classification).toBe("brilliant");
    expect(r.v2!.diagnostics.brilliant!.checks.every((c) => c.pass)).toBe(true);
  });
});

describe("Brilliant: negative cases", () => {
  it("a fake sacrifice that simply loses a bishop", async () => {
    const r = await classify("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", "f1a6");
    expect(r.classification).toBe("blunder");
    expect(r.v2!.explanation.summary).toContain("loses a bishop");
  });

  it("an obvious recapture", async () => {
    const r = await classify("r1bqkbnr/1ppp1ppp/p1B5/4p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4", "d7c6", "b5c6");
    expect(["best", "excellent"]).toContain(r.classification);
  });

  it("a trivial mate in one", async () => {
    const r = await classify("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", "a1a8");
    expect(r.classification).toBe("best");
  });

  it("an automatic promotion", async () => {
    const r = await classify("8/5P1k/8/8/8/8/6K1/8 w - - 0 1", "f7f8q");
    expect(r.classification).toBe("best");
  });
});
