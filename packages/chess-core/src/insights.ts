// Deterministic building blocks for position insights (V2 plan §25–30). Engine lines decide what
// actually happens; these helpers describe material and immediate tactics precisely.
import { Chess, type PieceSymbol, type Square } from "chess.js";
import type { Colour, VariationMove } from "@chessanalyser/shared";
import { PIECE_NAMES, PIECE_VALUES, toColour, fromColour } from "./position";
import { isFork, nullMoveFen, staticExchange } from "./tactics";

export interface CheckOrCapture {
  san: string;
  uci: string;
  gain?: number;
}

export function checkingMoves(fen: string): CheckOrCapture[] {
  return new Chess(fen)
    .moves({ verbose: true })
    .filter((m) => /[+#]$/.test(m.san))
    .map((m) => ({ san: m.san, uci: m.lan }));
}

export function captureMoves(fen: string): CheckOrCapture[] {
  return new Chess(fen)
    .moves({ verbose: true })
    .filter((m) => m.captured && (!m.promotion || m.promotion === "q"))
    .map((m) => ({ san: m.san, uci: m.lan, gain: staticExchange(fen, m) }))
    .sort((a, b) => (b.gain ?? 0) - (a.gain ?? 0));
}

/** Position with `side` to move (a hypothetical "pass" when it is not their turn). */
export function fenWithSideToMove(fen: string, side: Colour): string | null {
  return new Chess(fen).turn() === fromColour(side) ? fen : nullMoveFen(fen);
}

export interface HangingPieceInfo {
  square: Square;
  piece: PieceSymbol;
  colour: Colour;
  value: number;
}

/** Pieces (not pawns or kings) the opponent could win outright by a capture sequence. */
export function hangingPieces(fen: string): HangingPieceInfo[] {
  const out: HangingPieceInfo[] = [];
  for (const attacker of ["white", "black"] as Colour[]) {
    const position = fenWithSideToMove(fen, attacker);
    if (!position) continue;
    const chess = new Chess(position);
    const best = new Map<Square, number>();
    for (const m of chess.moves({ verbose: true })) {
      if (!m.captured || m.captured === "p" || (m.promotion && m.promotion !== "q")) continue;
      const gain = staticExchange(position, m);
      if (gain > 0 && gain > (best.get(m.to) ?? 0)) best.set(m.to, gain);
    }
    for (const [square, value] of best) {
      const p = chess.get(square);
      if (p) out.push({ square, piece: p.type, colour: toColour(p.color), value });
    }
  }
  return out.sort((a, b) => b.value - a.value);
}

export interface ImmediateThreat {
  kind: "material" | "promotion" | "fork";
  san: string;
  uci: string;
  value: number;
  description: string;
}

/**
 * Immediate non-mate threats `side` would have if it were their move: winning captures, safe
 * promotions and safe forks. Mate threats need an engine search and are handled by the reviewer.
 */
export function immediateThreats(fen: string, side: Colour, materialThreshold = 2): ImmediateThreat[] {
  const position = fenWithSideToMove(fen, side);
  if (!position) return [];
  const chess = new Chess(position);
  const threats: ImmediateThreat[] = [];
  for (const m of chess.moves({ verbose: true })) {
    if (m.promotion && m.promotion !== "q") continue;
    const see = staticExchange(position, m);
    if (m.captured && see >= materialThreshold) {
      threats.push({
        kind: "material",
        san: m.san,
        uci: m.lan,
        value: see,
        description: `${m.san} wins the ${PIECE_NAMES[m.captured]} on ${m.to}`,
      });
    } else if (m.promotion && see >= 0) {
      threats.push({ kind: "promotion", san: m.san, uci: m.lan, value: 8, description: `${m.san} promotes` });
    } else if (!m.captured && see >= 0 && m.piece !== "k" && isFork(m.after, m.to)) {
      threats.push({ kind: "fork", san: m.san, uci: m.lan, value: 3, description: `${m.san} forks two pieces` });
    }
  }
  const order = { material: 0, promotion: 1, fork: 2 };
  return threats.sort((a, b) => order[a.kind] - order[b.kind] || b.value - a.value);
}

type Counts = Record<PieceSymbol, number>;

function pieceCounts(fen: string): Record<Colour, Counts> {
  const empty = (): Counts => ({ p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 });
  const counts = { white: empty(), black: empty() };
  for (const row of new Chess(fen).board()) for (const sq of row) if (sq) counts[toColour(sq.color)][sq.type] += 1;
  return counts;
}

const ARTICLE: Record<PieceSymbol, string> = { p: "a pawn", n: "a knight", b: "a bishop", r: "a rook", q: "the queen", k: "the king" };

/**
 * Plain-English description of the net material `colour` lost between two positions, e.g. "a bishop",
 * "a knight for a pawn", "the exchange". Equal trades along the way cancel out.
 */
export function describeMaterialChange(fromFen: string, toFen: string, colour: Colour): { net: number; lost: string } {
  const a = pieceCounts(fromFen);
  const b = pieceCounts(toFen);
  const opp: Colour = colour === "white" ? "black" : "white";
  const order: PieceSymbol[] = ["q", "r", "b", "n", "p"];
  // Positive = colour is down that many of this piece type relative to the opponent's losses.
  const netLost: Partial<Counts> = {};
  let net = 0;
  for (const p of order) {
    const own = a[colour][p] - b[colour][p];
    const theirs = a[opp][p] - b[opp][p];
    netLost[p] = own - theirs;
    net += (theirs - own) * PIECE_VALUES[p];
  }
  // Bishops and knights are netted together: losing a knight for a bishop is an even trade.
  const minor = (netLost.b ?? 0) + (netLost.n ?? 0);
  const minorName = (count: number) => {
    if (count > 1) return `${count} pieces`;
    if ((netLost.n ?? 0) > 0 && (netLost.b ?? 0) <= 0) return ARTICLE.n;
    if ((netLost.b ?? 0) > 0 && (netLost.n ?? 0) <= 0) return ARTICLE.b;
    return "a piece";
  };
  const units: { name: string; value: number; lost: number }[] = [
    { name: (netLost.q ?? 0) > 1 ? `${netLost.q} queens` : ARTICLE.q, value: 9, lost: netLost.q ?? 0 },
    { name: (netLost.r ?? 0) > 1 ? `${netLost.r} rooks` : ARTICLE.r, value: 5, lost: netLost.r ?? 0 },
    { name: minorName(minor), value: 3, lost: minor },
    { name: (netLost.p ?? 0) > 1 ? `${netLost.p} pawns` : ARTICLE.p, value: 1, lost: netLost.p ?? 0 },
  ];
  const lostUnits = units.filter((u) => u.lost > 0);
  const gainedUnits = units.filter((u) => u.lost < 0);
  let text = "material";
  if ((netLost.r ?? 0) === 1 && minor === -1 && !netLost.q) text = "the exchange";
  else if (lostUnits.length) {
    const top = lostUnits[0]!;
    text = top.name;
    const gain = gainedUnits[0];
    if (gain && gain.value < top.value) {
      const gainName = gain.value === 3 ? (gain.lost < -1 ? `${-gain.lost} pieces` : "a piece") : gain.value === 1 ? (gain.lost < -1 ? `${-gain.lost} pawns` : "a pawn") : gain.value === 5 ? "a rook" : "a queen";
      text += ` for ${gainName}`;
    }
  }
  return { net, lost: text };
}

/** Engine lines get less reliable with depth: material is judged within this many plies. */
export const MATERIAL_HORIZON_PLIES = 12;

export interface MaterialSequence {
  /** Net material change for `colour` by the end of the line (pawns; negative = lost). */
  net: number;
  /** Plies until the final material balance is reached and kept. */
  plies: number;
  description: string;
  endFen: string;
}

/**
 * Material outcome of a line for `colour`. The line is cut to an even length so both sides have
 * moved equally, which avoids counting a capture whose recapture is the next move.
 */
export function materialSequence(
  startFen: string,
  line: VariationMove[],
  colour: Colour,
  horizon = MATERIAL_HORIZON_PLIES,
): MaterialSequence | null {
  const cut = Math.min(line.length, horizon);
  const usable = cut - (cut % 2);
  if (usable < 2) return null;
  const nets: number[] = [];
  for (let i = 0; i < usable; i++) nets.push(describeMaterialChange(startFen, line[i]!.fenAfter, colour).net);
  const final = nets[usable - 1]!;
  let plies = usable;
  for (let i = usable - 1; i >= 0 && nets[i] === final; i--) plies = i + 1;
  const endFen = line[usable - 1]!.fenAfter;
  return { net: final, plies, description: describeMaterialChange(startFen, endFen, colour).lost, endFen };
}
