import { Chess, DEFAULT_POSITION } from "chess.js";
import type { GameMove, GameResult } from "@chessanalyser/shared";

export interface ParsedGame {
  headers: Record<string, string>;
  startFen: string;
  variant: string;
  supported: boolean;
  result: GameResult;
  moves: Omit<GameMove, "gameId">[];
}

export class PgnParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgnParseError";
  }
}

const STANDARD_VARIANT_NAMES = new Set(["", "standard", "chess", "normal", "from position"]);

/** Header-only variant detection, so unsupported games can be listed without being replayed. */
export function detectVariant(headers: Record<string, string>): { variant: string; supported: boolean } {
  const raw = (headers.Variant ?? "").trim();
  const supported = STANDARD_VARIANT_NAMES.has(raw.toLowerCase());
  return { variant: raw === "" ? "standard" : raw, supported };
}

/**
 * Replay a PGN with chess.js and record every ply (spec §28). Variant games are returned with
 * `supported: false` and no moves rather than being replayed with standard rules.
 */
export function parseGame(pgn: string): ParsedGame {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch (err) {
    // A variant PGN (e.g. Chess960 castling) may not replay under standard rules; still report its headers.
    const headers = readHeadersLoosely(pgn);
    const { variant, supported } = detectVariant(headers);
    if (!supported) {
      return { headers, startFen: headers.FEN ?? DEFAULT_POSITION, variant, supported, result: toResult(headers.Result), moves: [] };
    }
    throw new PgnParseError(err instanceof Error ? err.message : String(err));
  }

  const headers = Object.fromEntries(
    Object.entries(chess.getHeaders()).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  const { variant, supported } = detectVariant(headers);
  const startFen = headers.SetUp === "1" && headers.FEN ? headers.FEN : DEFAULT_POSITION;
  if (!supported) {
    return { headers, startFen, variant, supported, result: toResult(headers.Result), moves: [] };
  }

  const moves = chess.history({ verbose: true }).map((m, i) => ({
    ply: i + 1,
    san: m.san,
    uci: m.lan,
    fenBefore: m.before,
    fenAfter: m.after,
  }));
  return { headers, startFen, variant, supported, result: toResult(headers.Result), moves };
}

export function toResult(raw: string | undefined): GameResult {
  if (raw === "1-0" || raw === "0-1" || raw === "1/2-1/2") return raw;
  return "*";
}

function readHeadersLoosely(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const match of pgn.matchAll(/^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm)) {
    headers[match[1]!] = match[2]!;
  }
  return headers;
}
