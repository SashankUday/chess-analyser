// The ONE place where White-POV evaluations become mover-relative values (V2 plan §2–3, §9).
// Engine adapters normalise to White's point of view; review code converts here and nowhere else.
import { RESULT_CLASS_BANDS } from "./constants";
import type { Colour, NormalisedEvaluation, ResultClass } from "./types";

/** Centipawn stand-in for a forced mate; mate in N maps to ±(MATE_CP − N). */
export const MATE_CP = 10_000;

/** Lichess clamps centipawns to ±1000 before converting to winning chances. */
const WIN_PERCENT_CP_CLAMP = 1000;
const LICHESS_K = 0.00368208;

/** Mover-relative centipawns: positive is good for `mover`. Mate and finished games map to ±MATE_CP. */
export function moverCp(evaluation: NormalisedEvaluation, mover: Colour): number {
  const sign = mover === "white" ? 1 : -1;
  const t = evaluation.terminal;
  if (t) return t.winner === null ? 0 : t.winner === mover ? MATE_CP : -MATE_CP;
  if (evaluation.mateForWhiteIn !== null) {
    const m = evaluation.mateForWhiteIn;
    const forWhite = m > 0 ? MATE_CP - m : -MATE_CP - m;
    return sign * forWhite;
  }
  return sign * (evaluation.whiteCp ?? 0);
}

/**
 * Forced-mate distance from `mover`'s point of view: positive = mover mates in N, negative = mover is
 * mated in N, null = no forced mate. A position where mate has already been delivered counts as
 * mate in 0 for the winner (returned as 0) and −1 for the side that was mated.
 */
export function moverMate(evaluation: NormalisedEvaluation, mover: Colour): number | null {
  const t = evaluation.terminal;
  if (t?.kind === "checkmate") return t.winner === mover ? 0 : -1;
  if (evaluation.mateForWhiteIn === null) return null;
  return mover === "white" ? evaluation.mateForWhiteIn : -evaluation.mateForWhiteIn;
}

/** True when `mover` has (or has already delivered) a forced mate. */
export function moverHasMate(evaluation: NormalisedEvaluation, mover: Colour): boolean {
  const m = moverMate(evaluation, mover);
  return m !== null && m >= 0;
}

/** True when `mover` is being (or has been) mated by force. */
export function moverIsMated(evaluation: NormalisedEvaluation, mover: Colour): boolean {
  const m = moverMate(evaluation, mover);
  return m !== null && m < 0;
}

/** Lichess winning-chances formula, 0–100, for the side the centipawns favour when positive. */
export function winPercentFromCp(cp: number): number {
  const c = Math.max(-WIN_PERCENT_CP_CLAMP, Math.min(WIN_PERCENT_CP_CLAMP, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-LICHESS_K * c)) - 1);
}

/** Mover-relative winning chances, 0–100. Forced mate is 100 (or 0); a finished draw is 50. */
export function moverWinPercent(evaluation: NormalisedEvaluation, mover: Colour): number {
  if (moverHasMate(evaluation, mover)) return 100;
  if (moverIsMated(evaluation, mover)) return 0;
  if (evaluation.terminal) return 50;
  return winPercentFromCp(moverCp(evaluation, mover));
}

/** Coarse game state for `mover` (V2 plan §12). */
export function resultClass(evaluation: NormalisedEvaluation, mover: Colour): ResultClass {
  if (moverHasMate(evaluation, mover)) return "FORCED_WIN";
  if (moverIsMated(evaluation, mover)) return "FORCED_LOSS";
  const win = moverWinPercent(evaluation, mover);
  const b = RESULT_CLASS_BANDS;
  if (win >= b.winning) return "WINNING";
  if (win >= b.advantage) return "ADVANTAGE";
  if (win > b.disadvantage) return "EQUAL";
  if (win > b.losing) return "DISADVANTAGE";
  return "LOSING";
}

const RESULT_ORDER: ResultClass[] = ["FORCED_LOSS", "LOSING", "DISADVANTAGE", "EQUAL", "ADVANTAGE", "WINNING", "FORCED_WIN"];

/** Numeric rank of a result class (higher is better for the mover). */
export function resultRank(r: ResultClass): number {
  return RESULT_ORDER.indexOf(r);
}

export const RESULT_LABELS: Record<ResultClass, string> = {
  FORCED_WIN: "a forced win",
  WINNING: "a winning position",
  ADVANTAGE: "an advantage",
  EQUAL: "an equal position",
  DISADVANTAGE: "a worse position",
  LOSING: "a losing position",
  FORCED_LOSS: "a forced loss",
};
