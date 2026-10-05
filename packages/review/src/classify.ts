// Review Algorithm 2 classification (V2 plan §7–13). Thresholds live in shared/constants.ts.
import {
  BEST_EQUIVALENCE,
  CP_LOSS_GUARDS,
  MATERIAL_OVERRIDE,
  RESULT_CLASS_BANDS,
  SJENG_CP_THRESHOLDS,
  VERIFICATION,
  WIN_LOSS_BANDS,
  resultRank,
  type MoveBadge,
  type MoveClassification,
  type MoveQualityMetrics,
} from "@chessanalyser/shared";

const SEVERITY: MoveClassification[] = ["brilliant", "great", "best", "excellent", "good", "inaccuracy", "mistake", "blunder"];

export function atLeast(c: MoveClassification, floor: MoveClassification): MoveClassification {
  if (c === "forced") return c;
  return SEVERITY.indexOf(c) >= SEVERITY.indexOf(floor) ? c : floor;
}

/** Whether the game is still undecided enough for centipawn guards to matter. */
function undecided(m: MoveQualityMetrics): boolean {
  return m.bestWinPercent > RESULT_CLASS_BANDS.losing && m.bestWinPercent < RESULT_CLASS_BANDS.winning;
}

/** A non-top move that might be engine-equivalent to the best move (must be verified). */
export function maybeEquivalent(m: MoveQualityMetrics): boolean {
  return m.playedRank !== 1 && m.winPercentLoss <= BEST_EQUIVALENCE.maxWinPercentLoss && m.cpLoss <= BEST_EQUIVALENCE.maxCpLoss;
}

/**
 * Normal severity from the same-root comparison. Best requires rank 1 — or `verifiedEquivalent`
 * after a deeper search — never merely a near-zero loss (V2 plan §7).
 */
export function classifyMetrics(m: MoveQualityMetrics, opts: { legalMoveCount: number; verifiedEquivalent?: boolean }): MoveClassification {
  if (opts.legalMoveCount === 1) return "forced";
  if (m.playedRank === 1 || opts.verifiedEquivalent) return "best";
  const loss = m.winPercentLoss;
  const guard = undecided(m);
  if (loss < WIN_LOSS_BANDS.excellent) {
    if (guard && m.cpLoss >= CP_LOSS_GUARDS.good) return "inaccuracy";
    if (guard && m.cpLoss >= CP_LOSS_GUARDS.excellent) return "good";
    return "excellent";
  }
  if (loss < WIN_LOSS_BANDS.good) return guard && m.cpLoss >= CP_LOSS_GUARDS.good ? "inaccuracy" : "good";
  if (loss < WIN_LOSS_BANDS.inaccuracy) return "inaccuracy";
  if (loss < WIN_LOSS_BANDS.mistake) return "mistake";
  return "blunder";
}

export interface EventFlags {
  allowsMate: boolean;
  missedMate: boolean;
  /** Mate distance the mover missed (moves), when `missedMate`. */
  missedMateIn: number | null;
  /** Net material the played line loses by force (pawns, positive = lost). */
  forcedMaterialLoss: number;
}

/** Deterministic chess events that raise the severity floor (V2 plan §13). */
export function applyOverrides(
  c: MoveClassification,
  m: MoveQualityMetrics,
  e: EventFlags,
): { classification: MoveClassification; overrides: string[]; badges: MoveBadge[] } {
  const overrides: string[] = [];
  const badges: MoveBadge[] = [];
  if (c === "forced") return { classification: c, overrides, badges };
  const before = resultRank(m.resultClassBefore);
  const after = resultRank(m.resultClassAfter);
  const WINNING = resultRank("WINNING");
  const EQUAL = resultRank("EQUAL");
  const LOSING = resultRank("LOSING");
  let out: MoveClassification = c;
  const floor = (to: MoveClassification, why: string) => {
    const next = atLeast(out, to);
    if (next !== out) overrides.push(why);
    out = next;
  };

  if (e.allowsMate) {
    badges.push("allows_mate");
    floor("blunder", "allows a forced mate");
  }
  if (e.missedMate) {
    badges.push("missed_mate");
    // Throwing away a short mate, or a mate whose alternative no longer wins, is a Blunder.
    if ((e.missedMateIn !== null && e.missedMateIn <= MISSED_MATE_BLUNDER_MAX) || after < WINNING) floor("blunder", "throws away a forced mate");
    else floor("mistake", "misses a forced mate");
  }
  if (before >= WINNING && after <= LOSING) floor("blunder", "winning → losing");
  else if (before >= EQUAL && after <= LOSING) floor("blunder", "equal → losing");
  else if (before >= WINNING && after <= EQUAL) floor("blunder", "throws away a winning position");
  if (before >= WINNING && after < WINNING && m.playedRank !== 1) badges.push("missed_win");
  if (
    e.forcedMaterialLoss >= MATERIAL_OVERRIDE.minLoss &&
    m.cpLoss >= MATERIAL_OVERRIDE.minCpShare * e.forcedMaterialLoss * 100
  ) {
    floor("blunder", "loses major material by force without compensation");
  }
  return { classification: out, overrides, badges };
}

/** Mates this short are "clearly forced": missing one is always a Blunder. */
export const MISSED_MATE_BLUNDER_MAX = 3;

/** Why a preliminary result deserves a deeper same-root search (V2 plan §14–15). */
export function verificationReasons(m: MoveQualityMetrics, c: MoveClassification, materialSwing: number, mateChanged: boolean): string[] {
  if (c === "forced" || m.playedRank === 1) return [];
  const reasons: string[] = [];
  if (maybeEquivalent(m)) reasons.push("possible engine-equivalent move");
  if (m.cpLoss >= VERIFICATION.cpLoss) reasons.push(`cp loss ${m.cpLoss}`);
  const bounds = [WIN_LOSS_BANDS.excellent, WIN_LOSS_BANDS.good, WIN_LOSS_BANDS.inaccuracy, WIN_LOSS_BANDS.mistake];
  const near = bounds.find((b) => Math.abs(m.winPercentLoss - b) <= VERIFICATION.boundaryMargin);
  if (near !== undefined) reasons.push(`Win% loss ${m.winPercentLoss} near ${near}`);
  if (m.resultClassBefore !== m.resultClassAfter) reasons.push(`${m.resultClassBefore} → ${m.resultClassAfter}`);
  if (mateChanged) reasons.push("mate score appears or disappears");
  if (materialSwing >= VERIFICATION.materialSwing) reasons.push(`material swing ${materialSwing}`);
  return reasons;
}

/** Reduced review for engines without MultiPV/searchmoves (Apple Chess/Sjeng). Sequential, conservative. */
export function classifyReducedCp(input: {
  legalMoveCount: number;
  playedIsBest: boolean;
  cpBest: number;
  cpPlayed: number;
}): { classification: MoveClassification; cpLoss: number } {
  const T = SJENG_CP_THRESHOLDS;
  const cpLoss = input.playedIsBest ? 0 : Math.max(0, input.cpBest - input.cpPlayed);
  if (input.legalMoveCount === 1) return { classification: "forced", cpLoss: 0 };
  const inWindow = Math.abs(input.cpBest) <= T.evalWindowCp || Math.abs(input.cpPlayed) <= T.evalWindowCp;
  const flipped = Math.sign(input.cpBest) !== Math.sign(input.cpPlayed) && cpLoss > T.good;
  let classification: MoveClassification;
  if (input.playedIsBest) classification = "best";
  else if (!inWindow && !flipped) classification = "good";
  else if (cpLoss <= T.good) classification = "good";
  else if (cpLoss <= T.inaccuracy) classification = "inaccuracy";
  else if (cpLoss <= T.mistake) classification = "mistake";
  else classification = "blunder";
  return { classification, cpLoss };
}
