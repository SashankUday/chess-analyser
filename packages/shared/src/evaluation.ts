import { EVAL_GRAPH_CAP_PAWNS } from "./constants";
import type { Colour, NormalisedEvaluation, Wdl } from "./types";

/** Expected result for `colour`: P(win) + ½·P(draw). Always in [0, 1]. */
export function expectedScore(wdl: Wdl, colour: Colour): number {
  const win = colour === "white" ? wdl.whiteWin : wdl.blackWin;
  return clamp01(win + 0.5 * wdl.draw);
}

/** WDL implied by a terminal or mating evaluation, where it is exact rather than estimated. */
export function exactWdl(evaluation: NormalisedEvaluation): Wdl | null {
  const t = evaluation.terminal;
  if (t) {
    if (t.winner === "white") return { whiteWin: 1, draw: 0, blackWin: 0 };
    if (t.winner === "black") return { whiteWin: 0, draw: 0, blackWin: 1 };
    return { whiteWin: 0, draw: 1, blackWin: 0 };
  }
  return null;
}

export function formatEvaluation(evaluation: NormalisedEvaluation): string {
  const t = evaluation.terminal;
  if (t) {
    if (t.winner === "white") return "1-0";
    if (t.winner === "black") return "0-1";
    return "½-½";
  }
  if (evaluation.mateForWhiteIn !== null) {
    return evaluation.mateForWhiteIn > 0 ? `M${evaluation.mateForWhiteIn}` : `-M${-evaluation.mateForWhiteIn}`;
  }
  const cp = evaluation.whiteCp ?? 0;
  const pawns = cp / 100;
  if (Math.abs(pawns) < 0.05) return "0.0";
  return `${pawns > 0 ? "+" : "-"}${Math.abs(pawns).toFixed(1)}`;
}

/**
 * Fraction of the evaluation bar that is White (0–1). Prefers WDL; falls back to a saturating
 * centipawn curve for engines without WDL. Mate and finished games pin the bar.
 */
export function whiteBarFraction(evaluation: NormalisedEvaluation, wdl?: Wdl): number {
  const t = evaluation.terminal;
  if (t) return t.winner === "white" ? 1 : t.winner === "black" ? 0 : 0.5;
  if (evaluation.mateForWhiteIn !== null) return evaluation.mateForWhiteIn > 0 ? 1 : 0;
  let fraction: number;
  if (wdl) fraction = expectedScore(wdl, "white");
  else fraction = 0.5 + 0.5 * Math.tanh((evaluation.whiteCp ?? 0) / 500);
  // Never fully empty the bar for a non-mate evaluation; +40 and +10 should look much the same.
  return Math.min(0.96, Math.max(0.04, fraction));
}

/** Graph value in pawns, capped at ±10. Mate pins to the cap; `null` means no data yet. */
export function graphValue(evaluation: NormalisedEvaluation): number {
  const cap = EVAL_GRAPH_CAP_PAWNS;
  const t = evaluation.terminal;
  if (t) return t.winner === "white" ? cap : t.winner === "black" ? -cap : 0;
  if (evaluation.mateForWhiteIn !== null) return evaluation.mateForWhiteIn > 0 ? cap : -cap;
  const pawns = (evaluation.whiteCp ?? 0) / 100;
  return Math.max(-cap, Math.min(cap, pawns));
}

export function opposite(colour: Colour): Colour {
  return colour === "white" ? "black" : "white";
}

/** Colour of the player who made the move at `ply` (ply 1 is White's first move in a standard game). */
export function moverAtPly(ply: number, startingColour: Colour = "white"): Colour {
  return ply % 2 === 1 ? startingColour : opposite(startingColour);
}

/** "23." / "23..." prefix for the move at `ply` in a game starting from the standard position. */
export function moveNumberLabel(ply: number): string {
  const n = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${n}.` : `${n}...`;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
