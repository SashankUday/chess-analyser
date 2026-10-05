// Deterministic tactical helpers used by review tags, explanations and the Brilliant detector.
// These describe material and threats; they never decide whether a move is good — Stockfish does that.
import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import type { Colour } from "@chessanalyser/shared";
import { PIECE_VALUES, fromColour, toColour } from "./position";

const FILES = "abcdefgh";
const ORDER_VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

function captureValue(m: Move): number {
  return (m.captured ? PIECE_VALUES[m.captured] : 0) + (m.promotion ? PIECE_VALUES[m.promotion] - 1 : 0);
}

/** Best material the side to move can gain by an exchange sequence on `square` (≥ 0; may decline). */
function seeOnSquare(chess: Chess, square: Square, depth: number): number {
  if (depth > 12) return 0;
  const captures = chess
    .moves({ verbose: true })
    .filter((m) => m.to === square && m.captured && (!m.promotion || m.promotion === "q"));
  if (captures.length === 0) return 0;
  captures.sort((a, b) => ORDER_VALUE[a.piece] - ORDER_VALUE[b.piece]);
  const m = captures[0]!;
  chess.move(m);
  const gain = captureValue(m) - seeOnSquare(chess, square, depth + 1);
  chess.undo();
  return Math.max(0, gain);
}

/**
 * Static exchange value of playing `move` from `fen`, for the mover, in pawns. Negative means the
 * move puts material where it can be won.
 */
export function staticExchange(fen: string, move: { from: string; to: string; promotion?: string }): number {
  const chess = new Chess(fen);
  const m = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  const gained = captureValue(m);
  if (chess.isCheckmate()) return gained;
  return gained - seeOnSquare(chess, m.to, 0);
}

/** The largest material gain available to the side to move by a single capture sequence. */
export function bestCaptureGain(fen: string): { gain: number; move: Move | null } {
  const chess = new Chess(fen);
  let best: { gain: number; move: Move | null } = { gain: 0, move: null };
  for (const m of chess.moves({ verbose: true })) {
    if (!m.captured) continue;
    if (m.promotion && m.promotion !== "q") continue;
    const g = staticExchange(fen, m);
    if (g > best.gain) best = { gain: g, move: m };
  }
  return best;
}

/** Flip the side to move (a "null move"). Returns null when that would be illegal (side in check). */
export function nullMoveFen(fen: string): string | null {
  const parts = fen.split(" ");
  parts[1] = parts[1] === "w" ? "b" : "w";
  parts[3] = "-";
  const flipped = parts.join(" ");
  try {
    const chess = new Chess(flipped);
    // The side that just "passed" must not be giving check to a king that can now be captured.
    const opponent = chess.turn() === "w" ? "b" : "w";
    const king = chess.findPiece({ type: "k", color: opponent })[0];
    if (king && chess.isAttacked(king, chess.turn())) return null;
    return flipped;
  } catch {
    return null;
  }
}

/**
 * Material `colour` stands to lose if the opponent were to move now: the best single capture
 * sequence the opponent has against `colour`'s pieces.
 */
export function threatenedLoss(fen: string, colour: Colour): { loss: number; square: Square | null; piece: PieceSymbol | null } {
  const opponentToMove = new Chess(fen).turn() !== fromColour(colour);
  const position = opponentToMove ? fen : nullMoveFen(fen);
  if (!position) return { loss: 0, square: null, piece: null };
  const { gain, move } = bestCaptureGain(position);
  return { loss: gain, square: move?.to ?? null, piece: move?.captured ?? null };
}

/** Squares a piece on `square` attacks, by geometry (pins ignored). */
export function attackedSquares(fen: string, square: Square): Square[] {
  const chess = new Chess(fen);
  const piece = chess.get(square);
  if (!piece) return [];
  const f = FILES.indexOf(square[0]!);
  const r = Number(square[1]) - 1;
  const out: Square[] = [];
  const at = (ff: number, rr: number): Square | null =>
    ff >= 0 && ff < 8 && rr >= 0 && rr < 8 ? (`${FILES[ff]}${rr + 1}` as Square) : null;
  const ray = (df: number, dr: number) => {
    for (let i = 1; i < 8; i++) {
      const s = at(f + df * i, r + dr * i);
      if (!s) return;
      out.push(s);
      if (chess.get(s)) return;
    }
  };
  const step = (offsets: [number, number][]) => {
    for (const [df, dr] of offsets) {
      const s = at(f + df, r + dr);
      if (s) out.push(s);
    }
  };
  switch (piece.type) {
    case "p":
      step(piece.color === "w" ? [[-1, 1], [1, 1]] : [[-1, -1], [1, -1]]);
      break;
    case "n":
      step([[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]);
      break;
    case "k":
      step([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]);
      break;
    case "b":
      [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([a, b]) => ray(a!, b!));
      break;
    case "r":
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => ray(a!, b!));
      break;
    case "q":
      [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => ray(a!, b!));
      break;
  }
  return out;
}

/**
 * Whether the piece on `square` forks two or more valuable targets: the king, pieces worth more
 * than the forking piece, or undefended pieces.
 */
export function isFork(fen: string, square: Square): boolean {
  const chess = new Chess(fen);
  const piece = chess.get(square);
  if (!piece) return false;
  const enemy = piece.color === "w" ? "b" : "w";
  let targets = 0;
  for (const s of attackedSquares(fen, square)) {
    const t = chess.get(s);
    if (!t || t.color !== enemy) continue;
    if (t.type === "k") targets += 1;
    else if (PIECE_VALUES[t.type] > PIECE_VALUES[piece.type]) targets += 1;
    else if (PIECE_VALUES[t.type] >= 3 && chess.attackers(s, enemy).length === 0) targets += 1;
  }
  return targets >= 2;
}

/** A move that checkmates immediately, if the side to move has one. */
export function mateInOne(fen: string): Move | null {
  const chess = new Chess(fen);
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    const mate = chess.isCheckmate();
    chess.undo();
    if (mate) return m;
  }
  return null;
}

/** After a move, would its author threaten mate-in-one if it were their turn again? */
export function createsMateThreat(fenAfter: string): boolean {
  const chess = new Chess(fenAfter);
  if (chess.inCheck()) return false;
  const passed = nullMoveFen(fenAfter);
  return passed ? mateInOne(passed) !== null : false;
}

/** A mate delivered by a rook or queen on the mated king's back rank. */
export function isBackRankMate(fenBeforeMate: string, mateUci: string): boolean {
  const chess = new Chess(fenBeforeMate);
  let m: Move;
  try {
    m = chess.move({ from: mateUci.slice(0, 2), to: mateUci.slice(2, 4), promotion: mateUci[4] });
  } catch {
    return false;
  }
  if (!chess.isCheckmate() || (m.piece !== "r" && m.piece !== "q")) return false;
  const matedColour = chess.turn();
  const backRank = matedColour === "w" ? "1" : "8";
  const king = chess.findPiece({ type: "k", color: matedColour })[0];
  return !!king && king[1] === backRank && m.to[1] === backRank;
}

/** Pieces of `colour` that were defending something before a capture removed the defender. */
export function defendedBy(fen: string, defenderSquare: Square): Square[] {
  const chess = new Chess(fen);
  const defender = chess.get(defenderSquare);
  if (!defender) return [];
  return attackedSquares(fen, defenderSquare).filter((s) => {
    const p = chess.get(s);
    return p && p.color === defender.color && p.type !== "k";
  });
}

export function pieceAt(fen: string, square: Square): { type: PieceSymbol; colour: Colour } | null {
  const p = new Chess(fen).get(square);
  return p ? { type: p.type, colour: toColour(p.color) } : null;
}
