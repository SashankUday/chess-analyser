// Great: a rank-1 move that is uniquely strong (V2 plan §16–17).
import { staticExchange } from "@chessanalyser/chess-core";
import { GREAT, resultRank, type DiagnosticCheck, type GameMove, type MoveQualityMetrics, type ResultClass } from "@chessanalyser/shared";

export interface GreatInput {
  move: GameMove;
  previousMove: GameMove | null;
  metrics: MoveQualityMetrics;
  legalMoveCount: number;
  /** The mover's result class before the opponent's previous move (from that position's best line). */
  previousResultClass: ResultClass | null;
}

export function detectGreat(input: GreatInput): { great: boolean; checks: DiagnosticCheck[]; reason: "only_move" | "turnaround" | null } {
  const { metrics: m } = input;
  const checks: DiagnosticCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => (checks.push({ name, pass, detail }), pass);

  if (!check("rank 1", m.playedRank === 1, `played rank ${m.playedRank ?? "outside top lines"}`)) return { great: false, checks, reason: null };
  if (!check("not forced", input.legalMoveCount > 1, `${input.legalMoveCount} legal moves`)) return { great: false, checks, reason: null };
  const recapture =
    !!input.previousMove && input.previousMove.san.includes("x") && input.previousMove.uci.slice(2, 4) === input.move.uci.slice(2, 4);
  if (!check("not a routine recapture", !recapture, recapture ? "recaptures on the same square" : "")) return { great: false, checks, reason: null };

  // Simply taking material that is hanging is "Best", not "Great": the gap to other moves is large,
  // but finding the move is not hard.
  const grab = input.move.san.includes("x")
    ? staticExchange(input.move.fenBefore, { from: input.move.uci.slice(0, 2), to: input.move.uci.slice(2, 4), promotion: input.move.uci[4] })
    : 0;
  if (!check("not an obvious material grab", grab < GREAT.obviousCaptureGain, grab ? `captures, winning ${grab} by exchange` : "")) {
    return { great: false, checks, reason: null };
  }

  if (!check("not a mate in one", !input.move.san.endsWith("#"), input.move.san.endsWith("#") ? "delivers mate" : "")) {
    return { great: false, checks, reason: null };
  }

  const crit = m.criticality ?? 0;
  const improved =
    input.previousResultClass !== null && resultRank(m.resultClassAfter) > resultRank(input.previousResultClass);
  // Decided: even the second-best move keeps a winning position, so no single move is critical.
  const second = m.rootMoves[1];
  const decided = m.bestWinPercent > GREAT.maxWinPercentBefore && (second?.winPercent ?? 100) >= GREAT.maxWinPercentBefore;
  if (!check("position not already decided", !decided, `best ${m.bestWinPercent}, second-best ${second?.winPercent ?? "–"} Win%`)) {
    return { great: false, checks, reason: null };
  }

  const onlyMove = crit >= GREAT.onlyMoveGap;
  check("only move (criticality)", onlyMove, `gap to second-best ${crit} Win% (needs ≥ ${GREAT.onlyMoveGap})`);
  const turnaround = improved && crit >= GREAT.transitionGap;
  check(
    "turns the game around",
    turnaround,
    input.previousResultClass ? `${input.previousResultClass} → ${m.resultClassAfter}, gap ${crit}` : "no previous position",
  );
  if (onlyMove) return { great: true, checks, reason: "only_move" };
  if (turnaround) return { great: true, checks, reason: "turnaround" };
  return { great: false, checks, reason: null };
}
