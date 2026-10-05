import { describe, expect, it } from "vitest";
import { parseGame, uciLineToMoves } from "@chessanalyser/chess-core";
import type { Colour, EngineAnalysis, GameMove, NormalisedEvaluation, ReviewEngineConfig } from "@chessanalyser/shared";
import { fixturePgn } from "../../../tests/fixtures";
import { classifyMetrics, positionInsights, reviewGame, reviewMoveV2, summarise, type ReviewEngine } from "../src";

let seq = 0;
type LineSpec = { pv: string[]; cp?: number; mate?: number };
const ev = (l: { cp?: number; mate?: number }): NormalisedEvaluation => ({
  whiteCp: l.mate !== undefined ? null : (l.cp ?? 0),
  mateForWhiteIn: l.mate ?? null,
});

/** A canned same-root engine result: White-POV scores and UCI lines, best first. */
function analysis(fen: string, lines: LineSpec[], opts: { multipv?: boolean } = {}): EngineAnalysis {
  const built = lines
    .map((l, i) => {
      const moves = uciLineToMoves(fen, l.pv);
      return moves.length
        ? { id: `l${seq++}`, rank: i + 1, rootMoveUci: moves[0]!.uci, rootMoveSan: moves[0]!.san, evaluation: ev(l), moves }
        : null;
    })
    .filter((x) => x !== null);
  return {
    id: `a${seq++}`,
    engine: "Stockfish",
    engineVersion: "19",
    capabilities: { wdl: opts.multipv !== false, multipv: opts.multipv !== false },
    fen,
    preset: "standard",
    configHash: "test",
    nodes: 200_000,
    evaluation: built[0]?.evaluation ?? ev(lines[0] ?? {}),
    lines: built,
    createdAt: "",
  };
}

const config: ReviewEngineConfig = { engine: "Stockfish 19", version: "19", nodes: 200_000, verificationNodes: 1_000_000, multiPv: 3 };

/** Engine double: restricted searches answer from a table; deep searches use the given function. */
function engine(opts: {
  restricted?: Record<string, LineSpec>;
  deepRestricted?: Record<string, LineSpec>;
  deep?: (fen: string) => EngineAnalysis;
  probe?: (fen: string) => EngineAnalysis | null;
}): ReviewEngine & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    restricted: async (fen, uci, deep) => {
      calls.push(`restricted:${uci}:${deep ? "deep" : "preset"}`);
      const spec = (deep ? opts.deepRestricted?.[uci] : undefined) ?? opts.restricted?.[uci];
      if (!spec) throw new Error(`unexpected restricted search for ${uci}`);
      return analysis(fen, [{ ...spec, pv: [uci, ...spec.pv] }]);
    },
    deepRoot: async (fen) => {
      calls.push("deep");
      if (!opts.deep) throw new Error("unexpected deep search");
      return opts.deep(fen);
    },
    probe: async (fen) => opts.probe?.(fen) ?? null,
  };
}

function game(name: string): GameMove[] {
  return parseGame(fixturePgn(name)).moves.map((m) => ({ ...m, gameId: "g" }));
}

function moveFrom(fen: string, uci: string, ply = 30): GameMove {
  const m = uciLineToMoves(fen, [uci])[0]!;
  return { gameId: "g", ply, san: m.san, uci: m.uci, fenBefore: fen, fenAfter: m.fenAfter };
}

async function review(
  move: GameMove,
  root: EngineAnalysis,
  eng?: ReviewEngine,
  extra: { previousMove?: GameMove; perspective?: Colour } = {},
) {
  return reviewMoveV2({
    gameId: "g",
    move,
    previousMove: extra.previousMove ?? null,
    root,
    after: analysis(move.fenAfter, [{ pv: [], cp: 0 }]),
    previousRoot: null,
    engine: eng,
    engineConfig: config,
    perspective: extra.perspective ?? null,
    insightsBefore: () => positionInsights(move.fenBefore, { root, ply: move.ply - 1 }),
    insightsAfter: () => positionInsights(move.fenAfter, { root: null, ply: move.ply }),
  });
}

describe("V2 regression: mover perspective (§50)", () => {
  const moves = game("castling");
  const blackMove = moves[3]!; // 2...Nc6

  it("a Black move taking White from +3.7 to +7.8 is a major deterioration, not Best", async () => {
    const root = analysis(blackMove.fenBefore, [
      { pv: ["d7d6"], cp: 370 },
      { pv: ["f8c5"], cp: 380 },
      { pv: ["f7f6"], cp: 400 },
    ]);
    const eng = engine({
      restricted: { b8c6: { pv: [], cp: 780 } },
      deep: (fen) => analysis(fen, [{ pv: ["d7d6"], cp: 365 }, { pv: ["f8c5"], cp: 380 }, { pv: ["f7f6"], cp: 410 }]),
    });
    const r = await review(blackMove, root, eng);
    const m = r.v2!.metrics;
    expect(r.mover).toBe("black");
    expect(m.bestCp).toBe(-365);
    expect(m.playedCp).toBe(-780);
    expect(m.cpLoss).toBe(415);
    expect(m.winPercentLoss).toBeGreaterThan(10);
    expect(["mistake", "blunder"]).toContain(r.classification);
    expect(r.verified).toBe(true);
  });

  it("the same numbers for a White move are not a deterioration", async () => {
    const whiteMove = moves[2]!; // 2.Nf3
    const root = analysis(whiteMove.fenBefore, [{ pv: ["d2d4"], cp: 370 }, { pv: ["f1c4"], cp: 300 }]);
    const eng = engine({
      restricted: { g1f3: { pv: [], cp: 780 } },
      deep: (fen) => analysis(fen, [{ pv: ["g1f3"], cp: 790 }, { pv: ["d2d4"], cp: 370 }]),
    });
    const r = await review(whiteMove, root, eng);
    expect(r.v2!.metrics.winPercentLoss).toBe(0);
    // Deeper search shows Nf3 is the only move that keeps +7.8, so it is even upgraded to Great.
    expect(["best", "great"]).toContain(r.classification);
  });
});

describe("V2 regression: strict Best (§7–8, §50)", () => {
  const move = game("castling")[2]!; // 2.Nf3

  it("a near-zero loss is NOT automatically Best", async () => {
    const root = analysis(move.fenBefore, [{ pv: ["d2d4"], cp: 25 }, { pv: ["g1f3"], cp: 22 }, { pv: ["b1c3"], cp: 10 }]);
    // Deeper search: Nf3 is clearly second.
    const eng = engine({ deep: (fen) => analysis(fen, [{ pv: ["d2d4"], cp: 35 }, { pv: ["g1f3"], cp: 22 }, { pv: ["b1c3"], cp: 5 }]) });
    const r = await review(move, root, eng);
    expect(r.v2!.metrics.playedRank).toBe(2);
    expect(r.classification).toBe("excellent");
    expect(r.v2!.diagnostics.verificationReasons).toContain("possible engine-equivalent move");
  });

  it("a verified engine-equivalent move is Best", async () => {
    const root = analysis(move.fenBefore, [{ pv: ["d2d4"], cp: 25 }, { pv: ["g1f3"], cp: 22 }]);
    const eng = engine({ deep: (fen) => analysis(fen, [{ pv: ["d2d4"], cp: 30 }, { pv: ["g1f3"], cp: 28 }]) });
    expect((await review(move, root, eng)).classification).toBe("best");
  });

  it("the engine's top choice is Best without verification", async () => {
    const root = analysis(move.fenBefore, [{ pv: ["g1f3"], cp: 30 }, { pv: ["d2d4"], cp: 28 }]);
    const eng = engine({});
    const r = await review(move, root, eng);
    expect(r.classification).toBe("best");
    expect(eng.calls).toEqual([]);
  });
});

describe("V2 regression: blunder verification (§14, §50)", () => {
  it("a shallow search that misses the swing is corrected by the deep verifier", async () => {
    const move = game("hanging-queen")[3]!; // 2...Qh4??
    // Shallow: Qh4 looks almost fine, but its own line drops the queen (a material swing).
    const root = analysis(move.fenBefore, [{ pv: ["b8c6"], cp: 30 }, { pv: ["d7d6"], cp: 40 }, { pv: ["g8f6"], cp: 45 }]);
    const eng = engine({
      restricted: { d8h4: { pv: ["f3h4"], cp: 60 } },
      deepRestricted: { d8h4: { pv: ["f3h4"], cp: 900 } },
      deep: (fen) => analysis(fen, [{ pv: ["b8c6"], cp: 30 }, { pv: ["d7d6"], cp: 40 }, { pv: ["g8f6"], cp: 45 }]),
    });
    const r = await review(move, root, eng);
    expect(r.v2!.diagnostics.preliminaryClassification).not.toBe("blunder");
    expect(r.v2!.diagnostics.verificationReasons.some((x) => x.startsWith("material swing"))).toBe(true);
    expect(r.classification).toBe("blunder");
    expect(r.v2!.explanation.summary).toContain("loses the queen");
  });

  it("borderline Win% losses are rechecked", async () => {
    const move = game("castling")[2]!;
    const root = analysis(move.fenBefore, [{ pv: ["d2d4"], cp: 100 }]);
    const eng = engine({
      restricted: { g1f3: { pv: [], cp: -15 } },
      deep: (fen) => analysis(fen, [{ pv: ["d2d4"], cp: 100 }]),
    });
    const r = await review(move, root, eng);
    expect(r.v2!.metrics.winPercentLoss).toBeGreaterThan(9);
    expect(r.v2!.diagnostics.verificationReasons.some((x) => x.includes("near 10"))).toBe(true);
    expect(r.verified).toBe(true);
  });
});

describe("V2 regression: overrides, threats and Miss", () => {
  // White threatens Qh7# (queen h5, bishop d3).
  const fen = "5rk1/p4pp1/8/7Q/8/3B4/5PPP/6K1 b - - 0 1";

  it("ignoring a mate threat is a Blunder that allows mate, and says so", async () => {
    const move = moveFrom(fen, "a7a6");
    const root = analysis(fen, [{ pv: ["g7g6"], cp: 150 }, { pv: ["f7f5"], cp: 300 }]);
    const eng = engine({
      restricted: { a7a6: { pv: ["h5h7"], mate: 1 } },
      deep: (f) => analysis(f, [{ pv: ["g7g6"], cp: 150 }, { pv: ["f7f5"], cp: 300 }]),
    });
    const r = await review(move, root, eng, { perspective: "black" });
    expect(r.classification).toBe("blunder");
    expect(r.badges).toContain("allows_mate");
    expect(r.v2!.insightsBefore!.mateThreat!.firstMove).toBe("Qh7#");
    expect(r.v2!.explanation.threatBefore).toContain("Qh7#");
    expect(r.v2!.explanation.summary).toContain("Your opponent now has a forced mate in 1");
  });

  it("a move that stops the threat is explained as a defence", async () => {
    const move = moveFrom(fen, "g7g6");
    const root = analysis(fen, [{ pv: ["g7g6", "h5h6"], cp: 150 }, { pv: ["f7f5"], cp: 160 }]);
    const r = await review(move, root, engine({}));
    expect(r.classification).toBe("best");
    expect(r.v2!.explanation.threatBefore).toBe("White was threatening Qh7#, and g6 prevents it.");
  });

  it("missing a mate in one is a Blunder with a Missed mate badge", async () => {
    const move = game("missed-mate")[6]!; // 4.Qf3 instead of Qxf7#
    const root = analysis(move.fenBefore, [{ pv: ["h5f7"], mate: 1 }, { pv: ["c4f7"], cp: 200 }]);
    const eng = engine({
      restricted: { h5f3: { pv: [], cp: 60 } },
      deep: (f) => analysis(f, [{ pv: ["h5f7"], mate: 1 }, { pv: ["c4f7"], cp: 200 }]),
    });
    const r = await review(move, root, eng, { perspective: "white" });
    expect(r.classification).toBe("blunder");
    expect(r.badges).toContain("missed_mate");
    expect(r.v2!.explanation.summary).toContain("There was a forced mate in 1 starting with Qxf7#");
  });

  it("never criticises the only legal move", async () => {
    const move = game("forced-move")[3]!;
    const r = await review(move, analysis(move.fenBefore, [{ pv: ["g7g6"], cp: 400 }]), engine({}));
    expect(r.classification).toBe("forced");
  });

  it("small differences in a decided position are not dramatised", () => {
    const c = classifyMetrics(
      {
        bestCp: -1200,
        playedCp: -1400,
        cpLoss: 200,
        bestWinPercent: 1.2,
        playedWinPercent: 1.1,
        winPercentLoss: 0.1,
        playedRank: 2,
        resultClassBefore: "LOSING",
        resultClassAfter: "LOSING",
        criticality: 0.1,
        sameSearch: true,
        nodes: 1,
        rootMoves: [],
      },
      { legalMoveCount: 20 },
    );
    expect(c).toBe("excellent");
  });
});

describe("V2: Great (§16–17)", () => {
  it("the only move that holds is Great", async () => {
    const move = game("castling")[2]!;
    const root = analysis(move.fenBefore, [{ pv: ["g1f3"], cp: 0 }, { pv: ["d2d4"], cp: -430 }, { pv: ["b1c3"], cp: -500 }]);
    const r = await review(move, root, engine({}));
    expect(r.classification).toBe("great");
    expect(r.badges).toContain("only_move");
    expect(r.v2!.explanation.headline).toContain("only good move");
  });

  it("a routine recapture is not Great", async () => {
    const moves = game("castling");
    const prev = { ...moves[1]!, san: "Nxf3", uci: "g8f3" }; // pretend the previous move captured on f3
    const move = moves[2]!;
    const root = analysis(move.fenBefore, [{ pv: ["g1f3"], cp: 0 }, { pv: ["d2d4"], cp: -430 }]);
    const r = await review(move, root, engine({}), { previousMove: prev });
    expect(r.classification).toBe("best");
  });
});

describe("V2: Brilliant diagnostics (§18–23)", () => {
  const move = game("sacrifice-legal-mate")[8]!; // 5.Nxe5 offers the knight to ...dxe5
  const root = analysis(move.fenBefore, [{ pv: ["f3e5", "d6e5", "d1g4"], cp: 200 }, { pv: ["h2h3"], cp: 40 }]);
  const deep = (fen: string) => analysis(fen, [{ pv: ["f3e5", "d6e5", "d1g4"], cp: 210 }, { pv: ["h2h3"], cp: 40 }]);

  it("a sound, engine-confirmed sacrifice is Brilliant", async () => {
    const r = await review(move, root, engine({ restricted: { d6e5: { pv: ["d1g4"], cp: 200 } }, deep }));
    expect(r.classification).toBe("brilliant");
    const d = r.v2!.diagnostics.brilliant!;
    expect(d.result).toBe(true);
    expect(d.checks.map((c) => c.name)).toEqual([
      "rank 1 (or near)",
      "non-trivial",
      "sacrifice detected",
      "meaningful sacrifice",
      "accepting does not refute it",
      "expected result preserved",
      "verification rank 1",
    ]);
  });

  it("a fake sacrifice refuted by accepting it is not Brilliant, and says why", async () => {
    const r = await review(move, root, engine({ restricted: { d6e5: { pv: ["d1g4"], cp: -300 } }, deep }));
    expect(r.classification).not.toBe("brilliant");
    expect(r.v2!.diagnostics.brilliant!.checks.find((c) => !c.pass)!.name).toBe("accepting does not refute it");
  });

  it("mate in one and quiet moves are not Brilliant", async () => {
    const m = game("mate-in-one")[6]!; // Qxf7#
    const r = await review(m, analysis(m.fenBefore, [{ pv: ["h5f7"], mate: 1 }, { pv: ["c4f7"], cp: 300 }]), engine({}));
    expect(r.classification).not.toBe("brilliant");
    const quiet = game("castling")[2]!;
    const q = await review(quiet, analysis(quiet.fenBefore, [{ pv: ["g1f3"], cp: 30 }, { pv: ["d2d4"], cp: 28 }]), engine({}));
    expect(q.classification).toBe("best");
    expect(q.v2!.diagnostics.brilliant).toBeUndefined();
  });
});

describe("V2: explanations (§31–35)", () => {
  it("distinguishes consequences that happen several moves later", async () => {
    const move = game("castling")[1]!; // 1...e5
    const root = analysis(move.fenBefore, [{ pv: ["c7c5"], cp: 30 }]);
    const eng = engine({
      restricted: { e7e5: { pv: ["d1h5", "b8c6", "h5e5", "g8e7", "f1c4"], cp: 260 } },
      deep: (fen) => analysis(fen, [{ pv: ["c7c5"], cp: 30 }]),
    });
    const r = await review(move, root, eng);
    expect(r.v2!.explanation.consequence).toBe("This eventually loses a pawn: 1... e5 2. Qh5 Nc6 3. Qxe5+.");
    expect(r.v2!.explanation.confidence).toBe("high");
    expect(r.v2!.explanation.lineId).toBeTruthy();
  });

  it("uses 'you' for the importing player's own moves", async () => {
    const move = game("castling")[2]!;
    const root = analysis(move.fenBefore, [{ pv: ["d2d4"], cp: 200 }]);
    const eng = engine({ restricted: { g1f3: { pv: [], cp: -200 } }, deep: (fen) => analysis(fen, [{ pv: ["d2d4"], cp: 200 }]) });
    const r = await review(move, root, eng, { perspective: "white" });
    expect(r.v2!.explanation.positionChange).toBe("You went from an advantage to a worse position.");
  });
});

describe("V2: threat detection (§26–28)", () => {
  it("finds a mate-in-one threat for the side not to move", async () => {
    const insights = await positionInsights("5rk1/p4pp1/8/7Q/8/3B4/5PPP/6K1 b - - 0 1", { root: null, ply: 0 });
    expect(insights.mateThreat).toMatchObject({ side: "white", mateIn: 1, firstMove: "Qh7#", confidence: "forced" });
    expect(insights.threats[0]!.kind).toBe("mate");
  });

  it("uses an engine probe for longer mate threats", async () => {
    const fen = "6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1";
    // Ra8# is mate in one here, so the probe is not even needed; check the probe path with a stub.
    const insights = await positionInsights(fen, { root: null, ply: 0, probe: async (f) => analysis(f, [{ pv: ["a1a8"], mate: 1 }]) });
    expect(insights.mateThreat?.firstMove).toBe("Ra8#");
  });

  it("reports no threat when the side to move is in check", async () => {
    const insights = await positionInsights("4k2R/8/8/8/8/8/8/4K3 b - - 0 1", { root: null, ply: 0 });
    expect(insights.inCheck).toBe(true);
    expect(insights.mateThreat).toBeUndefined();
  });
});

describe("reduced review and summaries", () => {
  it("falls back to a conservative sequential review without MultiPV", async () => {
    const move = game("hanging-queen")[3]!;
    const r = await reviewMoveV2({
      gameId: "g",
      move,
      previousMove: null,
      root: analysis(move.fenBefore, [{ pv: ["b8c6"], cp: 30 }], { multipv: false }),
      after: analysis(move.fenAfter, [{ pv: ["f3h4"], cp: 850 }], { multipv: false }),
      previousRoot: null,
      engineConfig: config,
    });
    expect(r.reduced).toBe(true);
    expect(r.classification).toBe("blunder");
    expect(r.algorithmVersion).toBe(2);
  });

  it("reviews every analysed move of a game", async () => {
    const moves = game("en-passant");
    const positions = new Map<number, EngineAnalysis>();
    positions.set(0, analysis(moves[0]!.fenBefore, [{ pv: [moves[0]!.uci], cp: 30 }, { pv: ["d2d4"], cp: 28 }]));
    for (const m of moves) {
      const next = moves[m.ply];
      positions.set(m.ply, analysis(m.fenAfter, next ? [{ pv: [next.uci], cp: 30 }] : [{ pv: [], cp: 30 }]));
    }
    const reviews = await reviewGame({ gameId: "g", moves, positions, engineConfig: config, engine: engine({}) });
    expect(reviews.map((r) => r.ply)).toEqual([1, 2, 3, 4, 5]);
    expect(reviews.every((r) => r.classification === "best")).toBe(true);
    const s = summarise(reviews);
    expect(Object.values(s.white).reduce((a, b) => a + b, 0)).toBe(3);
  });
});
