import { parseGame, sourceGameIdFromUrl, toResult, type ParsedGame } from "@chessanalyser/chess-core";
import type { Colour, GameMove, GameResult, Profile, TimeClass } from "@chessanalyser/shared";
import { ChessComClient, type ChessComGame, type ConditionalCache } from "./client";

export interface ImportedGame {
  sourceGameId: string;
  url: string | null;
  white: { username: string; rating: number | null };
  black: { username: string; rating: number | null };
  result: GameResult;
  playedAt: string;
  timeControl: string;
  timeClass: TimeClass;
  eco: string | null;
  openingName: string | null;
  variant: string;
  supported: boolean;
  userColour: Colour | null;
  pgn: string;
  startFen: string;
  moves: Omit<GameMove, "gameId">[];
}

export interface GameImportError {
  archiveUrl: string;
  sourceGameId: string | null;
  error: string;
}

export interface MonthBatch {
  archiveUrl: string;
  games: ImportedGame[];
  errors: GameImportError[];
  /** Persist only after the batch's games are stored, so a failed import is retried next sync. */
  cache: ConditionalCache;
}

export interface SyncContext {
  getCache(url: string): ConditionalCache | null;
  touchCache?(url: string): void;
  /** Limit to the newest N months. */
  months?: number;
  onProgress?(message: string): void;
}

/** Extensibility point (spec §78): Lichess or a PGN folder can implement this later. */
export interface GameSource {
  syncProfile(profile: Profile, ctx: SyncContext): Promise<ImportedGame[]>;
}

const TIME_CLASSES: TimeClass[] = ["bullet", "blitz", "rapid", "classical", "daily"];

export class ChessComSource implements GameSource {
  constructor(private readonly client = new ChessComClient()) {}

  async syncProfile(profile: Profile, ctx: SyncContext): Promise<ImportedGame[]> {
    const all: ImportedGame[] = [];
    for await (const batch of this.months(profile, ctx)) all.push(...batch.games);
    return all;
  }

  /** Newest months first; months unchanged since the last sync (HTTP 304) are skipped. */
  async *months(profile: Profile, ctx: SyncContext): AsyncGenerator<MonthBatch> {
    const archives = await this.client.getArchives(profile.username);
    const selected = ctx.months ? archives.slice(0, ctx.months) : archives;
    for (const [i, archiveUrl] of selected.entries()) {
      ctx.onProgress?.(`Checking ${monthLabel(archiveUrl)} (${i + 1}/${selected.length})`);
      const month = await this.client.getMonth(archiveUrl, ctx.getCache(archiveUrl));
      if (month.status === "not_modified") {
        ctx.touchCache?.(archiveUrl);
        continue;
      }
      const games: ImportedGame[] = [];
      const errors: GameImportError[] = [];
      for (const g of month.games) {
        try {
          games.push(toImportedGame(g, profile.username));
        } catch (err) {
          errors.push({ archiveUrl, sourceGameId: g.url ? sourceGameIdFromUrl(g.url) : null, error: (err as Error).message });
        }
      }
      yield { archiveUrl, games, errors, cache: { etag: month.etag, lastModified: month.lastModified } };
    }
  }
}

export function toImportedGame(g: ChessComGame, username: string): ImportedGame {
  if (!g.pgn) throw new Error("Game has no PGN.");
  const sourceGameId = (g.url && sourceGameIdFromUrl(g.url)) ?? g.uuid;
  if (!sourceGameId) throw new Error("Game has no identifier.");

  const rules = (g.rules ?? "chess").toLowerCase();
  let parsed: ParsedGame;
  if (rules !== "chess") {
    // Variants are listed but never replayed under standard rules (spec §26).
    parsed = { headers: {}, startFen: "", variant: rules, supported: false, result: "*", moves: [] };
    try {
      parsed = { ...parseGame(g.pgn), supported: false, moves: [], variant: rules };
    } catch {
      // keep the minimal record
    }
  } else {
    parsed = parseGame(g.pgn);
  }
  const h = parsed.headers;
  const me = username.toLowerCase();
  const userColour: Colour | null =
    g.white.username.toLowerCase() === me ? "white" : g.black.username.toLowerCase() === me ? "black" : null;

  return {
    sourceGameId,
    url: g.url ?? null,
    white: { username: g.white.username, rating: g.white.rating ?? null },
    black: { username: g.black.username, rating: g.black.rating ?? null },
    result: parsed.result !== "*" ? parsed.result : resultFromPlayers(g),
    playedAt: g.end_time ? new Date(g.end_time * 1000).toISOString() : headerDate(h) ?? new Date(0).toISOString(),
    timeControl: g.time_control ?? h.TimeControl ?? "-",
    timeClass: TIME_CLASSES.includes(g.time_class as TimeClass) ? (g.time_class as TimeClass) : "unknown",
    eco: h.ECO ?? null,
    openingName: openingNameFromUrl(h.ECOUrl ?? g.eco ?? null),
    variant: parsed.variant,
    supported: parsed.supported,
    userColour,
    pgn: g.pgn,
    startFen: parsed.startFen || h.FEN || "",
    moves: parsed.moves,
  };
}

function resultFromPlayers(g: ChessComGame): GameResult {
  if (g.white.result === "win") return "1-0";
  if (g.black.result === "win") return "0-1";
  const draws = ["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"];
  if (draws.includes(g.white.result ?? "")) return "1/2-1/2";
  return toResult(undefined);
}

function headerDate(h: Record<string, string>): string | null {
  const d = h.UTCDate ?? h.Date;
  if (!d || d.includes("?")) return null;
  const t = h.UTCTime ?? h.EndTime ?? "00:00:00";
  const iso = new Date(`${d.replace(/\./g, "-")}T${t}Z`);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

/** "https://www.chess.com/openings/Sicilian-Defense-Bowdler-Attack" → "Sicilian Defense Bowdler Attack". */
export function openingNameFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = /\/openings\/([^?#]+)/.exec(url);
  if (!m) return null;
  return decodeURIComponent(m[1]!)
    .replace(/-(\d)/g, " $1")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function monthLabel(url: string): string {
  const m = /(\d{4})\/(\d{2})$/.exec(url);
  return m ? `${m[1]}-${m[2]}` : url;
}
