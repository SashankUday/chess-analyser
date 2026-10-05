import { exactWdl, expectedScore, type Colour, type EngineAnalysis, type EngineLine } from "@chessanalyser/shared";

/** Mover's expected result from a stored analysis, or null when it has no WDL (reduced mode). */
export function expectedFor(analysis: EngineAnalysis, colour: Colour): number | null {
  const wdl = analysis.wdl ?? exactWdl(analysis.evaluation);
  return wdl ? expectedScore(wdl, colour) : null;
}

export function lineExpectedFor(line: EngineLine, colour: Colour): number | null {
  return line.wdl ? expectedScore(line.wdl, colour) : null;
}

/** Centipawns from `colour`'s point of view; mate maps to ±(10000 − distance). */
export function cpFor(analysis: Pick<EngineAnalysis, "evaluation">, colour: Colour): number {
  const e = analysis.evaluation;
  const sign = colour === "white" ? 1 : -1;
  if (e.terminal) return e.terminal.winner === null ? 0 : e.terminal.winner === colour ? 10_000 : -10_000;
  if (e.mateForWhiteIn !== null) {
    const forWhite = e.mateForWhiteIn > 0 ? 10_000 - e.mateForWhiteIn : -10_000 - e.mateForWhiteIn;
    return sign * forWhite;
  }
  return sign * (e.whiteCp ?? 0);
}

/** Moves until `colour` delivers mate (positive), is mated (negative), or null for no forced mate. */
export function mateFor(analysis: Pick<EngineAnalysis, "evaluation">, colour: Colour): number | null {
  const e = analysis.evaluation;
  if (e.terminal?.kind === "checkmate") return e.terminal.winner === colour ? 0 : -1; // 0: already delivered; -1: already mated
  if (e.mateForWhiteIn === null) return null;
  return colour === "white" ? e.mateForWhiteIn : -e.mateForWhiteIn;
}
