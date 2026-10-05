// Same-root move-quality metrics (V2 plan §5–10). Every score is mover-relative and comes from
// searches of the SAME pre-move position, so independent-search noise cannot drive a label.
import {
  moverCp,
  moverWinPercent,
  resultClass,
  type Colour,
  type EngineAnalysis,
  type EngineLine,
  type MoveQualityMetrics,
  type NormalisedEvaluation,
  type RootMoveScore,
} from "@chessanalyser/shared";

/** Centipawn losses above this are reported as this value (mate swings would otherwise dwarf everything). */
export const CP_LOSS_CAP = 1000;

export function scoreEvaluation(evaluation: NormalisedEvaluation, mover: Colour): { cp: number; winPercent: number } {
  return { cp: moverCp(evaluation, mover), winPercent: moverWinPercent(evaluation, mover) };
}

export function rootMoves(root: EngineAnalysis, mover: Colour): RootMoveScore[] {
  return root.lines.map((l) => ({ san: l.rootMoveSan, uci: l.rootMoveUci, ...scoreEvaluation(l.evaluation, mover), rank: l.rank }));
}

export interface PlayedScore {
  evaluation: NormalisedEvaluation;
  rank: number | null;
  sameSearch: boolean;
  line: EngineLine | null;
}

/** Find the played move among the root's MultiPV lines. */
export function playedFromRoot(root: EngineAnalysis, uci: string): PlayedScore | null {
  const line = root.lines.find((l) => l.rootMoveUci === uci);
  return line ? { evaluation: line.evaluation, rank: line.rank, sameSearch: true, line } : null;
}

/** The played move's score from a `searchmoves` search of the same root. */
export function playedFromRestricted(restricted: EngineAnalysis): PlayedScore {
  return { evaluation: restricted.lines[0]?.evaluation ?? restricted.evaluation, rank: null, sameSearch: false, line: restricted.lines[0] ?? null };
}

export function computeMetrics(root: EngineAnalysis, played: PlayedScore, mover: Colour): MoveQualityMetrics {
  const moves = rootMoves(root, mover);
  const bestEval = root.lines[0]?.evaluation ?? root.evaluation;
  const best = scoreEvaluation(bestEval, mover);
  const p = scoreEvaluation(played.evaluation, mover);
  const isBest = played.rank === 1;
  return {
    bestCp: best.cp,
    playedCp: isBest ? best.cp : p.cp,
    cpLoss: isBest ? 0 : Math.min(CP_LOSS_CAP, Math.max(0, best.cp - p.cp)),
    bestWinPercent: round2(best.winPercent),
    playedWinPercent: round2(isBest ? best.winPercent : p.winPercent),
    winPercentLoss: isBest ? 0 : round2(Math.max(0, best.winPercent - p.winPercent)),
    playedRank: played.rank,
    resultClassBefore: resultClass(bestEval, mover),
    resultClassAfter: resultClass(isBest ? bestEval : played.evaluation, mover),
    criticality: moves.length >= 2 ? round2(moves[0]!.winPercent - moves[1]!.winPercent) : null,
    sameSearch: played.sameSearch,
    nodes: root.nodes ?? 0,
    rootMoves: moves.map((m) => ({ ...m, winPercent: round2(m.winPercent) })),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
