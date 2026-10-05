// Brilliant V2 (V2 plan §18–22): an explicit checklist with diagnostics, including an acceptance
// test — what happens if the opponent takes the offered material?
import {
  legalMoves,
  materialFor,
  pieceAt,
  staticExchange,
  threatenedLoss,
  type Square,
} from "@chessanalyser/chess-core";
import {
  BRILLIANT,
  MATE_CP,
  moverHasMate,
  moverWinPercent,
  resultRank,
  type BrilliantDiagnostics,
  type Colour,
  type DiagnosticCheck,
  type EngineAnalysis,
  type GameMove,
  type MoveQualityMetrics,
} from "@chessanalyser/shared";
import type { PlayedScore } from "./metrics";

export interface Sacrifice {
  amount: number;
  kind: "piece_en_prise" | "left_en_prise" | "exchange" | "queen" | "pv_deficit";
  /** The capture that accepts the sacrifice, from the position after the move. */
  acceptUci: string | null;
  acceptSan: string | null;
}

/** Tolerances for Brilliant (Win% points). */
export const BRILLIANT_V2 = {
  maxWinLoss: 1.5,
  /** Accepting must not be better for the opponent than their best reply by more than this. */
  acceptTolerance: 3,
} as const;

/** Detect an apparent sacrifice, looking past the immediate position (V2 plan §20). */
export function detectSacrifice(move: GameMove, mover: Colour, playedLine: PlayedScore["line"]): Sacrifice | null {
  const from = move.uci.slice(0, 2);
  const to = move.uci.slice(2, 4) as Square;
  const moved = pieceAt(move.fenBefore, from as Square);
  const see = staticExchange(move.fenBefore, { from, to, promotion: move.uci[4] });
  const replies = legalMoves(move.fenAfter);
  const captureOf = (square: string) =>
    replies
      .filter((m) => m.to === square && m.captured)
      .sort((a, b) => staticExchange(move.fenAfter, b) - staticExchange(move.fenAfter, a))[0] ?? null;

  const min = BRILLIANT.minConcessionForMate;
  if (-see >= min) {
    const accept = captureOf(to);
    const kind = moved?.type === "q" ? "queen" : moved?.type === "r" && -see <= 3 ? "exchange" : "piece_en_prise";
    return { amount: -see, kind, acceptUci: accept?.lan ?? null, acceptSan: accept?.san ?? null };
  }
  const before = threatenedLoss(move.fenBefore, mover);
  const now = threatenedLoss(move.fenAfter, mover);
  const exposed = now.loss - Math.max(0, before.loss) - Math.max(0, see);
  if (exposed >= min && now.square && now.square !== to) {
    const accept = captureOf(now.square);
    return { amount: exposed, kind: now.piece === "q" ? "queen" : "left_en_prise", acceptUci: accept?.lan ?? null, acceptSan: accept?.san ?? null };
  }
  // A deficit along the engine line counts only if the opponent takes material on their first reply
  // and the mover is still down after TWO full moves (so ordinary trades and recaptures don't count).
  const pv = (playedLine?.moves ?? []).slice(1, 1 + BRILLIANT.pvScanPlies);
  if (pv.length < 4) return null;
  const baseline = materialFor(move.fenBefore, mover);
  const deficits = pv.slice(0, 4).map((m) => baseline - materialFor(m.fenAfter, mover));
  const deficit = Math.min(...deficits);
  if (deficit >= min && legalMoves(move.fenAfter).some((r) => r.lan === pv[0]!.uci && r.captured)) {
    return { amount: deficit, kind: "pv_deficit", acceptUci: pv[0]!.uci, acceptSan: pv[0]!.san };
  }
  return null;
}

export interface BrilliantInput {
  move: GameMove;
  previousMove: GameMove | null;
  mover: Colour;
  metrics: MoveQualityMetrics;
  legalMoveCount: number;
  played: PlayedScore;
  /** Engine search restricted to the accepting capture from the position after the move. */
  acceptance?: (fenAfter: string, uci: string) => Promise<EngineAnalysis>;
  /** Deeper MultiPV search of the position before the move. */
  confirm?: (fenBefore: string) => Promise<EngineAnalysis>;
}

export class BrilliantDetector {
  async evaluate(input: BrilliantInput): Promise<BrilliantDiagnostics> {
    const { move, mover, metrics: m } = input;
    const checks: DiagnosticCheck[] = [];
    let sacrifice: BrilliantDiagnostics["sacrifice"];
    const done = (result: boolean): BrilliantDiagnostics => ({ candidate: true, checks, result, sacrifice });
    const check = (name: string, pass: boolean, detail: string) => (checks.push({ name, pass, detail }), pass);

    // 1. Engine quality. Near-rank-1 never covers a slower mate when a faster one exists.
    const slowerMate = m.playedRank !== 1 && m.bestCp > m.playedCp && m.bestCp >= MATE_CP - 100;
    const near = m.playedRank === 1 || (m.winPercentLoss <= BRILLIANT_V2.maxWinLoss && !slowerMate);
    if (!check("rank 1 (or near)", near, `rank ${m.playedRank ?? "–"}, Win% loss ${m.winPercentLoss}${slowerMate ? ", a faster mate exists" : ""}`)) {
      return done(false);
    }
    // 5. Non-triviality (checked early: cheap).
    const recapture =
      !!input.previousMove && input.previousMove.san.includes("x") && input.previousMove.uci.slice(2, 4) === move.uci.slice(2, 4);
    const trivial =
      input.legalMoveCount <= 1 ? "only legal move" : move.san.endsWith("#") ? "mate in one" : recapture ? "recapture" : null;
    if (!check("non-trivial", trivial === null, trivial ?? "")) return done(false);

    // 2. Apparent sacrifice.
    const sac = detectSacrifice(move, mover, input.played.line);
    if (sac) sacrifice = { amount: sac.amount, kind: sac.kind, acceptSan: sac.acceptSan };
    if (!check("sacrifice detected", sac !== null, sac ? `${sac.kind}, ${sac.amount} pawn(s)` : "no material is offered")) return done(false);

    const mateLine = moverHasMate(input.played.evaluation, mover);
    const needed = mateLine ? BRILLIANT.minConcessionForMate : BRILLIANT.minConcession;
    if (!check("meaningful sacrifice", sac!.amount >= needed, `${sac!.amount} offered, needs ≥ ${needed}${mateLine ? " (mating line)" : ""}`)) {
      return done(false);
    }
    // Already-won positions: the sacrifice must be necessary, or a real piece sacrifice for mate.
    if (m.resultClassBefore === "FORCED_WIN") {
      const ok = mateLine && sac!.amount >= BRILLIANT.mateSacrificeMin;
      if (!check("needed in a won position", ok, `forced win; mating sacrifice of ${sac!.amount}`)) return done(false);
    } else if (m.resultClassBefore === "WINNING") {
      const ok = (m.criticality ?? 0) >= BRILLIANT.winningOnlyMoveGap;
      if (!check("needed in a won position", ok, `already winning; gap to next-best ${m.criticality ?? "–"} Win%`)) return done(false);
    }

    // 3. Acceptance: does taking the material refute it?
    if (sac!.acceptUci && input.acceptance) {
      const accepted = await input.acceptance(move.fenAfter, sac!.acceptUci);
      const acceptWin = moverWinPercent(accepted.lines[0]?.evaluation ?? accepted.evaluation, mover);
      const ok = acceptWin >= m.playedWinPercent - BRILLIANT_V2.acceptTolerance;
      if (!check("accepting does not refute it", ok, `after ${sac!.acceptSan}: mover Win% ${acceptWin.toFixed(1)} vs ${m.playedWinPercent}`)) return done(false);
    } else {
      check("accepting does not refute it", true, sac!.acceptUci ? "no engine available; using the played line" : "offer is in the engine line");
    }

    // 4. Compensation: the mover keeps at least an equal game (or saves a lost one).
    const keeps = resultRank(m.resultClassAfter) >= resultRank("EQUAL");
    if (!check("expected result preserved", keeps, `${m.resultClassBefore} → ${m.resultClassAfter}`)) return done(false);
    if (m.bestWinPercent >= 97 && !mateLine) {
      check("not already completely winning", false, `mover Win% ${m.bestWinPercent} before the move`);
      return done(false);
    }

    // 6. Deeper confirmation.
    if (input.confirm) {
      const deep = await input.confirm(move.fenBefore);
      const best = deep.lines[0];
      const mine = deep.lines.find((l) => l.rootMoveUci === move.uci);
      const loss = best && mine ? moverWinPercent(best.evaluation, mover) - moverWinPercent(mine.evaluation, mover) : Infinity;
      const ok = best?.rootMoveUci === move.uci || loss <= BRILLIANT_V2.maxWinLoss;
      if (!check("verification rank 1", ok, mine ? `deep rank ${mine.rank}, loss ${loss.toFixed(2)}` : "not in deep top lines")) return done(false);
    } else {
      check("verification rank 1", false, "no deep verification available");
      return done(false);
    }
    return done(true);
  }
}
