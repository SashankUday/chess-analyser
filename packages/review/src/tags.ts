import {
  PIECE_NAMES,
  bestCaptureGain,
  materialFor,
  createsMateThreat,
  defendedBy,
  isBackRankMate,
  isFork,
  pieceAt,
  staticExchange,
  threatenedLoss,
  type Square,
} from "@chessanalyser/chess-core";
import { moveNumberLabel, opposite, type Colour, type EngineAnalysis, type GameMove, type MoveBadge, type TacticalTag } from "@chessanalyser/shared";

export interface TagInput {
  move: GameMove;
  mover: Colour;
  before: EngineAnalysis;
  after: EngineAnalysis;
  /** Expected-outcome loss, or a comparable 0–1 severity in reduced mode. */
  loss: number;
  playedIsBest: boolean;
  allowsMate: boolean;
  missedMate: boolean;
}

export interface TagResult {
  tags: TacticalTag[];
  badges: MoveBadge[];
  /** Facts the explanation generator can mention. */
  facts: {
    hungPiece?: string;
    hungSquare?: string;
    lostMaterial?: number;
    wonMaterial?: number;
    missedCaptureSan?: string;
    missedCaptureGain?: number;
    forkReplySan?: string;
    mateIn?: number;
    /** The engine's refutation, when material is lost further down its line. */
    refutation?: string;
  };
}

const LOSS_MATTERS = 0.05;

/** Deterministic tactical tags (spec §14). Engine lines confirm that a pattern actually matters. */
export function detectTags(input: TagInput): TagResult {
  const { move, mover, before, after, loss, playedIsBest } = input;
  const tags: TacticalTag[] = [];
  const badges: MoveBadge[] = [];
  const facts: TagResult["facts"] = {};
  const from = move.uci.slice(0, 2);
  const to = move.uci.slice(2, 4);
  const reply = after.lines[0]?.moves[0];
  const engineBad = loss >= LOSS_MATTERS;

  const gain = staticExchange(move.fenBefore, { from, to, promotion: move.uci[4] });
  const threatBefore = threatenedLoss(move.fenBefore, mover);
  const threatAfter = threatenedLoss(move.fenAfter, mover);

  // Material won by the move itself (net of the recapture sequence), confirmed harmless by the engine.
  if (gain >= 1 && !engineBad) {
    tags.push("wins_material");
    badges.push("wins_material");
    facts.wonMaterial = gain;
  }

  // Material left hanging: the opponent's best capture now, confirmed by the engine's reply.
  const net = Math.max(0, gain) - threatAfter.loss;
  if (engineBad && threatAfter.loss >= 1 && threatAfter.loss > threatBefore.loss - 0.5 && reply && reply.uci.slice(2, 4) === threatAfter.square) {
    const victim = threatAfter.piece;
    if (victim && victim !== "p" && threatAfter.loss >= 2) {
      tags.push("hangs_piece");
      facts.hungPiece = PIECE_NAMES[victim];
      facts.hungSquare = threatAfter.square ?? undefined;
    }
  }
  if (engineBad && (net <= -1 || gain <= -1)) {
    tags.push("loses_material");
    badges.push("loses_material");
    facts.lostMaterial = Math.max(-net, -gain);
  }

  // A capture the engine wanted that was not played.
  const bestLine = before.lines[0];
  if (!playedIsBest && bestLine && engineBad) {
    const capture = bestCaptureGain(move.fenBefore);
    if (capture.move && capture.gain >= 2 && capture.move.lan === bestLine.rootMoveUci) {
      tags.push("misses_capture");
      facts.missedCaptureSan = capture.move.san;
      facts.missedCaptureGain = capture.gain;
    }
  }

  if (input.allowsMate) {
    tags.push("allows_mate");
    const m = after.evaluation.mateForWhiteIn;
    if (m !== null) facts.mateIn = Math.abs(m);
    const pv = after.lines[0]?.moves ?? [];
    const last = pv.at(-1);
    const beforeLast = pv.length >= 2 ? pv[pv.length - 2]!.fenAfter : move.fenAfter;
    if (last && last.san.endsWith("#") && isBackRankMate(beforeLast, last.uci)) tags.push("back_rank_weakness");
  }
  if (input.missedMate) {
    tags.push("misses_mate");
    const m = before.evaluation.mateForWhiteIn;
    if (m !== null) facts.mateIn = Math.abs(m);
  }

  if (!engineBad && createsMateThreat(move.fenAfter)) tags.push("creates_mate_threat");

  // The opponent's best reply forks two valuable targets.
  if (engineBad && reply && isFork(reply.fenAfter, reply.uci.slice(2, 4) as Square)) {
    tags.push("allows_fork");
    facts.forkReplySan = reply.san;
  }

  // Capturing a defender, leaving what it defended undefended and attacked.
  const captured = pieceAt(move.fenBefore, to as Square);
  if (captured && captured.colour === opposite(mover) && !engineBad) {
    const defended = defendedBy(move.fenBefore, to as Square);
    const opponentThreat = defended.length ? threatenedLoss(move.fenAfter, opposite(mover)) : null;
    if (opponentThreat && opponentThreat.loss >= 2 && defended.includes(opponentThreat.square as Square)) {
      tags.push("removes_defender");
    }
  }

  // Deeper material loss: follow Stockfish's reply line to its end (after the mover's last reply)
  // and compare material with the position right after the move.
  const explained = tags.some((t) => ["hangs_piece", "loses_material", "allows_mate", "misses_mate"].includes(t));
  const pv = after.lines[0]?.moves ?? [];
  const usable = pv.length - (pv.length % 2);
  if (engineBad && !explained && usable >= 2) {
    const net = materialFor(pv[usable - 1]!.fenAfter, mover) - materialFor(move.fenAfter, mover);
    if (net <= -1) {
      tags.push("loses_material");
      badges.push("loses_material");
      facts.lostMaterial = -net;
      facts.refutation = formatLine(pv.slice(0, 4).map((m) => m.san), move.ply + 1) + (pv.length > 4 ? " …" : "");
    }
  }

  return { tags: [...new Set(tags)], badges: [...new Set(badges)], facts };
}

function formatLine(sans: string[], firstPly: number): string {
  return sans
    .map((san, i) => {
      const ply = firstPly + i;
      return i === 0 || ply % 2 === 1 ? `${moveNumberLabel(ply)} ${san}` : san;
    })
    .join(" ");
}
