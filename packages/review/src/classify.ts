import {
  BLUNDER_FALLBACK,
  BORDERLINE_MARGIN,
  CLASSIFICATION_THRESHOLDS,
  MISSED_WIN_FROM,
  MISSED_WIN_TO,
  SJENG_CP_THRESHOLDS,
  type MoveBadge,
  type MoveClassification,
} from "@chessanalyser/shared";

/** Label for an expected-outcome loss (spec §11). */
export function classifyLoss(loss: number): MoveClassification {
  for (const t of CLASSIFICATION_THRESHOLDS) if (loss <= t.max) return t.classification;
  return BLUNDER_FALLBACK;
}

/** Whether `loss` sits close enough to a label boundary to deserve a like-for-like recheck. */
export function isBorderline(loss: number, margin = BORDERLINE_MARGIN): boolean {
  return CLASSIFICATION_THRESHOLDS.some((t) => Math.abs(loss - t.max) <= margin);
}

const SEVERITY: MoveClassification[] = ["brilliant", "best", "excellent", "good", "inaccuracy", "mistake", "blunder"];

export function atLeast(c: MoveClassification, floor: MoveClassification): MoveClassification {
  if (c === "forced") return c;
  return SEVERITY.indexOf(c) >= SEVERITY.indexOf(floor) ? c : floor;
}

export interface WdlClassificationInput {
  legalMoveCount: number;
  playedIsBest: boolean;
  expectedBest: number;
  expectedPlayed: number;
  /** Forced-mate distances from the mover's point of view (positive = mover mates), before and after. */
  mateBefore: number | null;
  mateAfter: number | null;
}

export interface ClassificationResult {
  classification: MoveClassification;
  loss: number;
  badges: MoveBadge[];
  allowsMate: boolean;
  missedMate: boolean;
}

/**
 * Expected-outcome classification with overrides (spec §11–12). WDL already handles lost/won
 * positions: a −12 → −14 change costs almost nothing in expected score.
 */
export function classifyWithWdl(input: WdlClassificationInput): ClassificationResult {
  const loss = input.playedIsBest ? 0 : Math.max(0, input.expectedBest - input.expectedPlayed);
  const badges: MoveBadge[] = [];

  const opponentMatesAfter = input.mateAfter !== null && input.mateAfter < 0;
  const opponentMatedBefore = input.mateBefore !== null && input.mateBefore < 0;
  const allowsMate = opponentMatesAfter && !opponentMatedBefore;

  const moverMatedBefore = input.mateBefore !== null && input.mateBefore > 0;
  const stillMating = input.mateAfter !== null && input.mateAfter >= 0;
  const missedMate = moverMatedBefore && !stillMating && !input.playedIsBest;

  if (allowsMate) badges.push("allows_mate");
  if (missedMate) badges.push("missed_mate");
  if (!missedMate && input.expectedBest >= MISSED_WIN_FROM && input.expectedPlayed < MISSED_WIN_TO) {
    badges.push("missed_win");
  }

  if (input.legalMoveCount === 1) {
    // The only legal move is never criticised.
    return { classification: "forced", loss: 0, badges: [], allowsMate: false, missedMate: false };
  }

  let classification = classifyLoss(loss);
  if (allowsMate) classification = atLeast(classification, "blunder");
  return { classification, loss, badges, allowsMate, missedMate };
}

export interface CpClassificationInput {
  legalMoveCount: number;
  playedIsBest: boolean;
  /** Mover-relative centipawns (mate mapped to ±10000) for the best and the played move. */
  cpBest: number;
  cpPlayed: number;
  mateBefore: number | null;
  mateAfter: number | null;
}

/** Reduced review for engines without WDL (Apple Chess/Sjeng): conservative centipawn labels. */
export function classifyWithCp(input: CpClassificationInput): ClassificationResult & { cpLoss: number } {
  const T = SJENG_CP_THRESHOLDS;
  const cpLoss = input.playedIsBest ? 0 : Math.max(0, input.cpBest - input.cpPlayed);
  const badges: MoveBadge[] = [];
  const allowsMate = input.mateAfter !== null && input.mateAfter < 0 && !(input.mateBefore !== null && input.mateBefore < 0);
  const missedMate =
    input.mateBefore !== null && input.mateBefore > 0 && !(input.mateAfter !== null && input.mateAfter >= 0) && !input.playedIsBest;
  if (allowsMate) badges.push("allows_mate");
  if (missedMate) badges.push("missed_mate");

  if (input.legalMoveCount === 1) {
    return { classification: "forced", loss: 0, cpLoss: 0, badges: [], allowsMate: false, missedMate: false };
  }

  const inWindow = Math.abs(input.cpBest) <= T.evalWindowCp || Math.abs(input.cpPlayed) <= T.evalWindowCp;
  const flipped = Math.sign(input.cpBest) !== Math.sign(input.cpPlayed) && cpLoss > T.good;
  let classification: MoveClassification;
  if (input.playedIsBest || cpLoss <= T.best) classification = "best";
  else if (!inWindow && !flipped) classification = "good";
  else if (cpLoss <= T.good) classification = "good";
  else if (cpLoss <= T.inaccuracy) classification = "inaccuracy";
  else if (cpLoss <= T.mistake) classification = "mistake";
  else classification = "blunder";
  if (allowsMate) classification = atLeast(classification, "blunder");
  return { classification, loss: 0, cpLoss, badges, allowsMate, missedMate };
}
