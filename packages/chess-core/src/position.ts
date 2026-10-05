import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import type { Colour, TerminalState, VariationMove } from "@chessanalyser/shared";

export type { Square };

export const PIECE_VALUES: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export type MoveParseResult =
  | { ok: true; san: string; uci: string; fenAfter: string; move: Move }
  | { ok: false; error: "illegal" | "ambiguous" | "invalid_position"; message: string };

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export function load(fen: string): Chess {
  return new Chess(fen);
}

export function sideToMove(fen: string): Colour {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

export function toColour(c: "w" | "b"): Colour {
  return c === "w" ? "white" : "black";
}

export function fromColour(c: Colour): "w" | "b" {
  return c === "white" ? "w" : "b";
}

/**
 * Parse a user- or AI-supplied move (SAN or UCI) against a position. Rejects illegal and ambiguous
 * input instead of guessing (spec §48 analyse_candidate).
 */
export function parseMove(fen: string, text: string): MoveParseResult {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return { ok: false, error: "invalid_position", message: "The position is not valid." };
  }
  const legal = chess.moves({ verbose: true });
  const input = text.trim();

  const uci = UCI_RE.exec(input.toLowerCase());
  if (uci) {
    const [, from, to, promo] = uci;
    const match = legal.find((m) => m.from === from && m.to === to && (m.promotion ?? undefined) === (promo ?? undefined));
    if (match) return accept(match);
    // A bare UCI pawn move to the last rank without a promotion piece is ambiguous.
    if (!promo && legal.some((m) => m.from === from && m.to === to && m.promotion)) {
      return { ok: false, error: "ambiguous", message: `${input} needs a promotion piece, e.g. ${input}q.` };
    }
  }

  const wanted = normaliseSan(input);
  const exact = legal.filter((m) => normaliseSan(m.san) === wanted);
  if (exact.length === 1) return accept(exact[0]!);

  // Loose match: the same piece, destination and promotion with disambiguation left out.
  const loose = legal.filter((m) => stripDisambiguation(normaliseSan(m.san)) === stripDisambiguation(wanted));
  if (loose.length === 1) return accept(loose[0]!);
  if (loose.length > 1) {
    return {
      ok: false,
      error: "ambiguous",
      message: `${input} is ambiguous here: ${loose.map((m) => m.san).join(", ")}.`,
    };
  }
  return { ok: false, error: "illegal", message: `${input} is not a legal move in this position.` };
}

function accept(m: Move): MoveParseResult {
  return { ok: true, san: m.san, uci: m.lan, fenAfter: m.after, move: m };
}

function normaliseSan(san: string): string {
  return san.replace(/[+#!?]/g, "").replace(/0/g, "O").replace(/=/g, "").replace(/^P(?=[a-h])/, "");
}

function stripDisambiguation(san: string): string {
  // Nbd2 → Nd2, R1e1 → Re1, exd5 → xd5 is kept distinct from d5 by the capture marker.
  return san.replace(/^([NBRQK])[a-h1-8]{1,2}(?=x?[a-h][1-8])/, "$1");
}

/** Convert a UCI line (e.g. an engine PV) into SAN with FENs. Stops at the first illegal move. */
export function uciLineToMoves(fen: string, uciMoves: string[]): VariationMove[] {
  const chess = new Chess(fen);
  const out: VariationMove[] = [];
  for (const uci of uciMoves) {
    const m = UCI_RE.exec(uci);
    if (!m) break;
    try {
      const move = chess.move({ from: m[1]!, to: m[2]!, promotion: m[3] });
      out.push({ san: move.san, uci: move.lan, fenAfter: move.after });
    } catch {
      break;
    }
  }
  return out;
}

/** Convert a SAN line (Sjeng reports its PV in SAN) into moves. Stops at the first unparsable move. */
export function sanLineToMoves(fen: string, sanMoves: string[]): VariationMove[] {
  const out: VariationMove[] = [];
  let current = fen;
  for (const san of sanMoves) {
    const parsed = parseMove(current, san);
    if (!parsed.ok) break;
    out.push({ san: parsed.san, uci: parsed.uci, fenAfter: parsed.fenAfter });
    current = parsed.fenAfter;
  }
  return out;
}

export function legalMoves(fen: string): Move[] {
  return new Chess(fen).moves({ verbose: true });
}

export function legalMoveCount(fen: string): number {
  return new Chess(fen).moves().length;
}

export function terminalState(fen: string): TerminalState | undefined {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return { kind: "checkmate", winner: chess.turn() === "w" ? "black" : "white" };
  if (chess.isStalemate()) return { kind: "stalemate", winner: null };
  if (chess.isInsufficientMaterial()) return { kind: "insufficient_material", winner: null };
  return undefined;
}

export function isCheck(fen: string): boolean {
  return new Chess(fen).inCheck();
}

/** Square of the side-to-move's king when it is in check, for UI highlighting. */
export function checkedKingSquare(fen: string): Square | null {
  const chess = new Chess(fen);
  if (!chess.inCheck()) return null;
  return chess.findPiece({ type: "k", color: chess.turn() })[0] ?? null;
}

export interface Material {
  white: number;
  black: number;
  /** White minus Black, in pawns. */
  balance: number;
  pieces: Record<Colour, Record<PieceSymbol, number>>;
}

export function material(fen: string): Material {
  const chess = new Chess(fen);
  const empty = (): Record<PieceSymbol, number> => ({ p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 });
  const pieces: Record<Colour, Record<PieceSymbol, number>> = { white: empty(), black: empty() };
  let white = 0;
  let black = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      pieces[toColour(sq.color)][sq.type] += 1;
      if (sq.color === "w") white += PIECE_VALUES[sq.type];
      else black += PIECE_VALUES[sq.type];
    }
  }
  return { white, black, balance: white - black, pieces };
}

/** Material from `colour`'s point of view (own minus opponent), in pawns. */
export function materialFor(fen: string, colour: Colour): number {
  const m = material(fen);
  return colour === "white" ? m.balance : -m.balance;
}

/** Chess.com game URL → stable source id, e.g. `live/148327...` (spec §27). */
export function sourceGameIdFromUrl(url: string): string | null {
  const m = /chess\.com\/game\/(live|daily)\/(\d+)/i.exec(url) ?? /chess\.com\/(live|daily)\/game\/(\d+)/i.exec(url);
  if (m) return `${m[1]!.toLowerCase()}/${m[2]}`;
  const tail = /\/(\d+)(?:[?#].*)?$/.exec(url);
  return tail ? tail[1]! : null;
}
