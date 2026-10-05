import { describe, expect, it } from "vitest";
import { parseGame, uciLineToMoves } from "@chessanalyser/chess-core";
import type { EngineAnalysis, GameMove, Wdl } from "@chessanalyser/shared";
import { fixturePgn } from "../../../tests/fixtures";
import { classifyLoss, isBorderline, reviewGame, reviewMove, summarise, type ReviewVerifier } from "../src";

let seq = 0;
/** A canned engine result: White-POV WDL/cp/mate and a UCI principal variation. */
function analysis(
  fen: string,
  o: { wdl?: Wdl; cp?: number; mate?: number; pv?: string[]; capabilities?: { wdl: boolean; multipv: boolean } },
): EngineAnalysis {
  const evaluation = { whiteCp: o.mate !== undefined ? null : (o.cp ?? 0), mateForWhiteIn: o.mate ?? null };
  const moves = uciLineToMoves(fen, o.pv ?? []);
  return {
    id: `a${seq++}`,
    engine: "Stockfish",
    engineVersion: "19",
    capabilities: o.capabilities ?? { wdl: true, multipv: true },
    fen,
    preset: "standard",
    configHash: "test",
    evaluation,
    wdl: o.wdl,
    lines: moves.length
      ? [{ id: `l${seq++}`, rank: 1, rootMoveUci: moves[0]!.uci, rootMoveSan: moves[0]!.san, evaluation, wdl: o.wdl, moves }]
      : [],
    createdAt: "",
  };
}
const W = (whiteWin: number, draw: number, blackWin: number): Wdl => ({ whiteWin, draw, blackWin });

function game(name: string) {
  const g = parseGame(fixturePgn(name));
  return g.moves.map((m) => ({ ...m, gameId: "g" })) as GameMove[];
}

describe("thresholds", () => {
  it("labels expected-outcome loss by the configured bounds", () => {
    expect(classifyLoss(0)).toBe("best");
    expect(classifyLoss(0.005)).toBe("best");
    expect(classifyLoss(0.0051)).toBe("excellent");
    expect(classifyLoss(0.02)).toBe("excellent");
    expect(classifyLoss(0.05)).toBe("good");
    expect(classifyLoss(0.1)).toBe("inaccuracy");
    expect(classifyLoss(0.2)).toBe("mistake");
    expect(classifyLoss(0.2001)).toBe("blunder");
  });

  it("flags losses near a boundary for recheck", () => {
    expect(isBorderline(0.095)).toBe(true);
    expect(isBorderline(0.15)).toBe(false);
    expect(isBorderline(0.004)).toBe(true);
  });
});

describe("reviewMove", () => {
  it("never criticises the only legal move", async () => {
    const moves = game("forced-move");
    const m = moves[3]!; // 2...g6
    const r = await reviewMove({
      gameId: "g",
      move: m,
      previousMove: moves[2]!,
      before: analysis(m.fenBefore, { wdl: W(0.9, 0.05, 0.05), cp: 400, pv: ["g7g6"] }),
      after: analysis(m.fenAfter, { wdl: W(0.95, 0.03, 0.02), cp: 500, pv: ["h5e5"] }),
    });
    expect(r.classification).toBe("forced");
    expect(r.explanation).toBe("This was the only legal move.");
  });

  it("classifies allowing mate as at least a blunder and explains it", async () => {
    const moves = game("fools-mate");
    const m = moves[2]!; // 2.g4??
    const r = await reviewMove({
      gameId: "g",
      move: m,
      previousMove: moves[1]!,
      before: analysis(m.fenBefore, { wdl: W(0.2, 0.5, 0.3), cp: -60, pv: ["b1c3"] }),
      after: analysis(m.fenAfter, { mate: -1, wdl: W(0, 0, 1), pv: ["d8h4"] }),
    });
    expect(r.classification).toBe("blunder");
    expect(r.tags).toContain("allows_mate");
    expect(r.badges).toContain("allows_mate");
    expect(r.explanation).toContain("forced mate in 1");
    expect(r.bestMoveSan).toBe("Nc3");
  });

  it("does not treat already-unavoidable mate as newly allowed", async () => {
    const moves = game("fools-mate");
    const m = moves[2]!;
    const r = await reviewMove({
      gameId: "g",
      move: m,
      previousMove: null,
      before: analysis(m.fenBefore, { mate: -3, wdl: W(0, 0, 1), pv: ["b1c3"] }),
      after: analysis(m.fenAfter, { mate: -1, wdl: W(0, 0, 1), pv: ["d8h4"] }),
    });
    expect(r.tags).not.toContain("allows_mate");
    expect(r.classification).toBe("best");
  });

  it("does not dramatise small differences in an already-lost position", async () => {
    const moves = game("castling");
    const m = moves[0]!; // pretend White is already lost: −12 → −14
    const r = await reviewMove({
      gameId: "g",
      move: m,
      previousMove: null,
      before: analysis(m.fenBefore, { cp: -1200, wdl: W(0, 0.01, 0.99), pv: ["d2d4"] }),
      after: analysis(m.fenAfter, { cp: -1400, wdl: W(0, 0.004, 0.996), pv: ["e7e5"] }),
    });
    // E(White) 0.005 → 0.002: a 2-pawn swing that changes almost nothing.
    expect(r.expectedScoreLoss).toBeCloseTo(0.003, 6);
    expect(r.classification).toBe("best");
  });

  it("reports a missed mate", async () => {
    const moves = game("missed-mate");
    const m = moves[6]!; // 4.Qf3 instead of Qxf7#
    const r = await reviewMove({
      gameId: "g",
      move: m,
      previousMove: moves[5]!,
      before: analysis(m.fenBefore, { mate: 1, wdl: W(1, 0, 0), pv: ["h5f7"] }),
      after: analysis(m.fenAfter, { cp: 60, wdl: W(0.4, 0.45, 0.15), pv: ["c6d4"] }),
    });
    expect(r.badges).toContain("missed_mate");
    expect(r.tags).toContain("misses_mate");
    expect(r.classification).toBe("blunder");
    expect(r.explanation).toContain("forced mate in 1 starting with Qxf7#");
  });

  it("explains a hung queen", async () => {
    const moves = game("hanging-queen");
    const m = moves[3]!; // 2...Qh4??
    const r = await reviewMove({
      gameId: "g",
      move: m,
      previousMove: moves[2]!,
      before: analysis(m.fenBefore, { cp: 40, wdl: W(0.3, 0.55, 0.15), pv: ["b8c6"] }),
      after: analysis(m.fenAfter, { cp: 900, wdl: W(0.99, 0.01, 0), pv: ["f3h4"] }),
    });
    expect(r.mover).toBe("black");
    expect(r.classification).toBe("blunder");
    expect(r.tags).toEqual(expect.arrayContaining(["hangs_piece", "loses_material"]));
    expect(r.explanation).toContain("hangs the queen on h4");
  });

  it("awards Brilliant only after engine confirmation", async () => {
    const moves = game("sacrifice-legal-mate");
    const m = moves[8]!; // 5.Nxe5!!
    expect(m.san).toBe("Nxe5");
    const before = analysis(m.fenBefore, { cp: 300, wdl: W(0.85, 0.1, 0.05), pv: ["f3e5", "g4d1", "c4f7", "e8e7", "c3d5"] });
    const after = analysis(m.fenAfter, { cp: 300, wdl: W(0.85, 0.1, 0.05), pv: ["g4d1", "c4f7", "e8e7", "c3d5"] });
    const verifier: ReviewVerifier = {
      brilliant: async (fen) => analysis(fen, { cp: 320, wdl: W(0.86, 0.1, 0.04), pv: ["f3e5", "g4d1"] }),
      restricted: async () => {
        throw new Error("not expected");
      },
    };
    const unconfirmed = await reviewMove({ gameId: "g", move: m, previousMove: moves[7]!, before, after });
    expect(unconfirmed.classification).toBe("best");
    const confirmed = await reviewMove({ gameId: "g", move: m, previousMove: moves[7]!, before, after, verifier });
    expect(confirmed.classification).toBe("brilliant");
    expect(confirmed.verified).toBe(true);
  });

  it("does not award Brilliant for an ordinary developing move", async () => {
    const moves = game("castling");
    const m = moves[2]!; // 2.Nf3
    let asked = false;
    const verifier: ReviewVerifier = {
      brilliant: async (fen) => {
        asked = true;
        return analysis(fen, { pv: ["g1f3"], wdl: W(0.3, 0.6, 0.1) });
      },
      restricted: async (fen) => analysis(fen, { pv: [], wdl: W(0.3, 0.6, 0.1) }),
    };
    const r = await reviewMove({
      gameId: "g",
      move: m,
      previousMove: moves[1]!,
      before: analysis(m.fenBefore, { wdl: W(0.3, 0.6, 0.1), pv: ["g1f3"] }),
      after: analysis(m.fenAfter, { wdl: W(0.3, 0.6, 0.1), pv: ["b8c6", "f1c4"] }),
      verifier,
    });
    expect(r.classification).toBe("best");
    expect(asked).toBe(false);
  });

  it("rechecks borderline losses like-for-like and replaces the result", async () => {
    const moves = game("castling");
    const m = moves[2]!; // 2.Nf3, pretend best was d4
    const calls: string[] = [];
    const verifier: ReviewVerifier = {
      brilliant: async () => {
        throw new Error("not expected");
      },
      restricted: async (fen, uci) => {
        calls.push(uci);
        return analysis(fen, { pv: [uci], wdl: uci === "d2d4" ? W(0.6, 0.3, 0.1) : W(0.4, 0.3, 0.3) });
      },
    };
    const r = await reviewMove({
      gameId: "g",
      move: m,
      previousMove: moves[1]!,
      before: analysis(m.fenBefore, { wdl: W(0.5, 0.4, 0.1), pv: ["d2d4"] }), // E = 0.70
      after: analysis(m.fenAfter, { wdl: W(0.405, 0.4, 0.195), pv: ["b8c6"] }), // E = 0.605 → loss 0.095 (borderline)
      verifier,
    });
    expect(calls.sort()).toEqual(["d2d4", "g1f3"]);
    expect(r.verified).toBe(true);
    expect(r.expectedScoreLoss).toBeCloseTo(0.2, 5); // 0.75 vs 0.55 at the same budget
    expect(r.classification).toBe("mistake");
  });
});

describe("reduced (Apple Chess) review", () => {
  const noWdl = { wdl: false, multipv: false };

  it("uses centipawn loss within ±3 pawns and never awards Brilliant", async () => {
    const moves = game("hanging-queen");
    const m = moves[3]!;
    const r = await reviewMove({
      gameId: "g",
      move: m,
      previousMove: null,
      before: analysis(m.fenBefore, { cp: 30, pv: ["b8c6"], capabilities: noWdl }),
      after: analysis(m.fenAfter, { cp: 850, pv: ["f3h4"], capabilities: noWdl }),
      verifier: {
        brilliant: async () => {
          throw new Error("must not verify in reduced mode");
        },
        restricted: async () => {
          throw new Error("must not verify in reduced mode");
        },
      },
    });
    expect(r.reduced).toBe(true);
    expect(r.classification).toBe("blunder");
    expect(r.expectedScoreLoss).toBeNull();
    expect(r.expectedScoreBest).toBeNull();
    expect(r.explanation).toContain("Reduced review");
  });

  it("does not criticise moves in clearly decided positions", async () => {
    const moves = game("castling");
    const m = moves[0]!;
    const r = await reviewMove({
      gameId: "g",
      move: m,
      previousMove: null,
      before: analysis(m.fenBefore, { cp: 900, pv: ["d2d4"], capabilities: noWdl }),
      after: analysis(m.fenAfter, { cp: 700, pv: ["e7e5"], capabilities: noWdl }),
    });
    expect(r.classification).toBe("good");
  });
});

describe("reviewGame", () => {
  it("reviews every analysed move and summarises per side", async () => {
    const moves = game("en-passant");
    const positions = new Map<number, EngineAnalysis>();
    positions.set(0, analysis(moves[0]!.fenBefore, { wdl: W(0.3, 0.6, 0.1), pv: ["e2e4"] }));
    for (const m of moves) positions.set(m.ply, analysis(m.fenAfter, { wdl: W(0.3, 0.6, 0.1), pv: [] }));
    const reviews = await reviewGame({ gameId: "g", moves, positions });
    expect(reviews.map((r) => r.ply)).toEqual([1, 2, 3, 4, 5]);
    const s = summarise(reviews);
    expect(s.white.best + s.black.best).toBeGreaterThan(0);
    expect(Object.values(s.white).reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe("refutation lines", () => {
  it("explains material lost further down Stockfish's line", async () => {
    const moves = game("castling");
    const m = moves[1]!; // 1...e5
    const review = (pv: string[]) =>
      reviewMove({
        gameId: "g",
        move: m,
        previousMove: moves[0]!,
        before: analysis(m.fenBefore, { wdl: W(0.3, 0.6, 0.1), pv: ["c7c5"] }),
        after: analysis(m.fenAfter, { wdl: W(0.6, 0.35, 0.05), pv }),
      });
    // Nf3 Nc6 Nxe5 Nxe5: Black ends the line ahead, so no material loss is claimed.
    expect((await review(["g1f3", "b8c6", "f3e5", "c6e5"])).tags).not.toContain("loses_material");
    // Qh5 Nc6 Qxe5+ Nge7: Black is a pawn down after replying.
    const r = await review(["d1h5", "b8c6", "h5e5", "g8e7", "f1c4"]);
    expect(r.tags).toContain("loses_material");
    expect(r.explanation).toContain("Stockfish's reply wins a pawn for the opponent: 2. Qh5 Nc6 3. Qxe5+ Nge7 …");
  });
});
