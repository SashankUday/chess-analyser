import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_SETTINGS,
  type Colour,
  type EngineAnalysis,
  type EngineLine,
  type Game,
  type GameFilter,
  type GameMove,
  type GameSummary,
  type MoveReview,
  type Profile,
  type Settings,
  type TimeClass,
  type Variation,
} from "@chessanalyser/shared";
import { migrate, type AppliedMigration } from "./migrate";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T;

export function fenHash(fen: string): string {
  return crypto.createHash("sha256").update(fen.trim()).digest("hex");
}

export interface NewGame extends Omit<Game, "id" | "createdAt" | "plyCount"> {
  startFen: string;
}

export interface ImportFailure {
  profileId: string | null;
  archiveUrl: string | null;
  sourceGameId: string | null;
  error: string;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  tool: string;
  gameId: string | null;
  ply: number | null;
  lineId: string | null;
  result: string;
}

export interface StoredLine {
  line: EngineLine;
  analysisId: string;
  fen: string;
  engine: string;
}

export class ChessDb {
  readonly db: Database.Database;
  readonly migrations: AppliedMigration[];

  constructor(file: string, options: { migrationsDir?: string } = {}) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrations = migrate(this.db, options.migrationsDir);
  }

  close(): void {
    this.db.close();
  }

  // ---- profiles ----

  upsertProfile(source: "chesscom", username: string): Profile {
    const existing = this.db
      .prepare("SELECT * FROM profiles WHERE source = ? AND username = ?")
      .get(source, username) as Row | undefined;
    if (existing) return toProfile(existing);
    const profile: Profile = { id: crypto.randomUUID(), source, username, createdAt: now(), lastSyncAt: null };
    this.db
      .prepare("INSERT INTO profiles (id, source, username, created_at) VALUES (?, ?, ?, ?)")
      .run(profile.id, source, username, profile.createdAt);
    return profile;
  }

  getProfile(id: string): Profile | null {
    const row = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Row | undefined;
    return row ? toProfile(row) : null;
  }

  listProfiles(): Profile[] {
    return (this.db.prepare("SELECT * FROM profiles ORDER BY created_at").all() as Row[]).map(toProfile);
  }

  markProfileSynced(id: string): void {
    this.db.prepare("UPDATE profiles SET last_sync_at = ? WHERE id = ?").run(now(), id);
  }

  // ---- games ----

  hasGame(source: string, sourceGameId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM games WHERE source = ? AND source_game_id = ?").get(source, sourceGameId);
  }

  /** Insert a game and its moves atomically. Returns the new id, or null if it was already imported. */
  insertGame(game: NewGame, moves: Omit<GameMove, "gameId">[]): string | null {
    const id = crypto.randomUUID();
    const insert = this.db.transaction(() => {
      const res = this.db
        .prepare(
          `INSERT OR IGNORE INTO games (id, profile_id, source, source_game_id, url, pgn, white_username, black_username,
             white_rating, black_rating, result, played_at, time_control, time_class, eco, opening_name, variant,
             supported, user_colour, start_fen, ply_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          game.profileId,
          game.source,
          game.sourceGameId,
          game.url,
          game.pgn,
          game.white.username,
          game.black.username,
          game.white.rating,
          game.black.rating,
          game.result,
          game.playedAt,
          game.timeControl,
          game.timeClass,
          game.eco,
          game.openingName,
          game.variant,
          game.supported ? 1 : 0,
          game.userColour,
          game.startFen,
          moves.length,
          now(),
        );
      if (res.changes === 0) return null;
      const stmt = this.db.prepare(
        "INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const m of moves) stmt.run(id, m.ply, m.san, m.uci, m.fenBefore, m.fenAfter);
      return id;
    });
    return insert();
  }

  getGame(id: string): Game | null {
    const row = this.db.prepare("SELECT * FROM games WHERE id = ?").get(id) as Row | undefined;
    return row ? toGame(row) : null;
  }

  getStartFen(id: string): string | null {
    const row = this.db.prepare("SELECT start_fen FROM games WHERE id = ?").get(id) as Row | undefined;
    return row ? String(row.start_fen) : null;
  }

  listGames(opts: { profileId?: string; filter: GameFilter; limit: number; offset: number }): GameSummary[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.profileId) {
      where.push("g.profile_id = ?");
      params.push(opts.profileId);
    }
    const analysed = "EXISTS (SELECT 1 FROM move_reviews r WHERE r.game_id = g.id)";
    const userWon = "((g.user_colour = 'white' AND g.result = '1-0') OR (g.user_colour = 'black' AND g.result = '0-1'))";
    const userLost = "((g.user_colour = 'white' AND g.result = '0-1') OR (g.user_colour = 'black' AND g.result = '1-0'))";
    switch (opts.filter) {
      case "rapid":
      case "blitz":
      case "bullet":
      case "daily":
      case "classical":
        where.push("g.time_class = ?");
        params.push(opts.filter);
        break;
      case "wins":
        where.push(userWon);
        break;
      case "losses":
        where.push(userLost);
        break;
      case "draws":
        where.push("g.result = '1/2-1/2'");
        break;
      case "analysed":
        where.push(analysed);
        break;
      case "not_analysed":
        where.push(`NOT ${analysed}`);
        break;
      case "all":
        break;
    }
    const sql = `SELECT g.*, ${analysed} AS analysed FROM games g
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY g.played_at DESC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...params, opts.limit, opts.offset) as Row[]).map((r) => {
      const { pgn: _pgn, ...game } = toGame(r);
      return { ...game, analysed: !!r.analysed };
    });
  }

  getMoves(gameId: string): GameMove[] {
    return (this.db.prepare("SELECT * FROM moves WHERE game_id = ? ORDER BY ply").all(gameId) as Row[]).map(toMove);
  }

  getMove(gameId: string, ply: number): GameMove | null {
    const row = this.db.prepare("SELECT * FROM moves WHERE game_id = ? AND ply = ?").get(gameId, ply) as Row | undefined;
    return row ? toMove(row) : null;
  }

  // ---- engine analyses (cache) ----

  findAnalysis(fen: string, configHash: string): EngineAnalysis | null {
    const row = this.db
      .prepare("SELECT * FROM engine_analyses WHERE fen_hash = ? AND config_hash = ?")
      .get(fenHash(fen), configHash) as Row | undefined;
    return row ? this.hydrateAnalysis(row) : null;
  }

  getAnalysis(id: string): EngineAnalysis | null {
    const row = this.db.prepare("SELECT * FROM engine_analyses WHERE id = ?").get(id) as Row | undefined;
    return row ? this.hydrateAnalysis(row) : null;
  }

  saveAnalysis(a: EngineAnalysis, config: unknown): EngineAnalysis {
    const save = this.db.transaction(() => {
      // Replace any earlier result for the same position + configuration.
      this.db.prepare("DELETE FROM engine_analyses WHERE fen_hash = ? AND config_hash = ?").run(fenHash(a.fen), a.configHash);
      this.db
        .prepare(
          `INSERT INTO engine_analyses (id, fen_hash, fen, engine, engine_version, preset, config_hash, config_json,
             capabilities_json, nodes, depth, white_cp, mate_for_white_in, terminal_json, white_win, draw, black_win, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          a.id,
          fenHash(a.fen),
          a.fen,
          a.engine,
          a.engineVersion,
          a.preset,
          a.configHash,
          json(config),
          json(a.capabilities),
          a.nodes ?? null,
          a.depth ?? null,
          a.evaluation.whiteCp,
          a.evaluation.mateForWhiteIn,
          a.evaluation.terminal ? json(a.evaluation.terminal) : null,
          a.wdl?.whiteWin ?? null,
          a.wdl?.draw ?? null,
          a.wdl?.blackWin ?? null,
          a.createdAt,
        );
      const line = this.db.prepare(
        `INSERT INTO engine_lines (id, analysis_id, rank, root_move_uci, root_move_san, evaluation, wdl_json, moves_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of a.lines) {
        line.run(l.id, a.id, l.rank, l.rootMoveUci, l.rootMoveSan, json(l.evaluation), l.wdl ? json(l.wdl) : null, json(l.moves));
      }
    });
    save();
    return a;
  }

  getLine(lineId: string): StoredLine | null {
    const row = this.db
      .prepare(
        `SELECT l.*, a.fen AS fen, a.engine AS engine FROM engine_lines l
         JOIN engine_analyses a ON a.id = l.analysis_id WHERE l.id = ?`,
      )
      .get(lineId) as Row | undefined;
    if (!row) return null;
    return { line: toLine(row), analysisId: String(row.analysis_id), fen: String(row.fen), engine: String(row.engine) };
  }

  clearEngineCache(): number {
    return this.db.prepare("DELETE FROM engine_analyses").run().changes;
  }

  private hydrateAnalysis(row: Row): EngineAnalysis {
    const lines = (this.db
      .prepare("SELECT * FROM engine_lines WHERE analysis_id = ? ORDER BY rank")
      .all(row.id) as Row[]).map(toLine);
    const hasWdl = row.white_win !== null && row.white_win !== undefined;
    return {
      id: String(row.id),
      engine: String(row.engine),
      engineVersion: String(row.engine_version),
      capabilities: parse(row.capabilities_json),
      fen: String(row.fen),
      preset: String(row.preset) as EngineAnalysis["preset"],
      configHash: String(row.config_hash),
      nodes: numOrUndef(row.nodes),
      depth: numOrUndef(row.depth),
      evaluation: {
        whiteCp: numOrNull(row.white_cp),
        mateForWhiteIn: numOrNull(row.mate_for_white_in),
        ...(row.terminal_json ? { terminal: parse(row.terminal_json) } : {}),
      },
      wdl: hasWdl
        ? { whiteWin: Number(row.white_win), draw: Number(row.draw), blackWin: Number(row.black_win) }
        : undefined,
      lines,
      createdAt: String(row.created_at),
    };
  }

  // ---- per-game position links ----

  setGamePosition(gameId: string, ply: number, analysisId: string, engine: string): void {
    this.db
      .prepare(
        `INSERT INTO game_positions (game_id, ply, analysis_id, engine) VALUES (?, ?, ?, ?)
         ON CONFLICT (game_id, ply) DO UPDATE SET analysis_id = excluded.analysis_id, engine = excluded.engine`,
      )
      .run(gameId, ply, analysisId, engine);
  }

  getGamePositions(gameId: string): Map<number, EngineAnalysis> {
    const rows = this.db
      .prepare(
        `SELECT a.* , p.ply AS game_ply FROM game_positions p JOIN engine_analyses a ON a.id = p.analysis_id
         WHERE p.game_id = ? ORDER BY p.ply`,
      )
      .all(gameId) as Row[];
    const out = new Map<number, EngineAnalysis>();
    for (const r of rows) out.set(Number(r.game_ply), this.hydrateAnalysis(r));
    return out;
  }

  // ---- move reviews ----

  saveReviews(reviews: MoveReview[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO move_reviews (id, game_id, ply, mover, played_move_san, played_move_uci, classification, badges_json,
         evaluation_before, evaluation_after, expected_score_best, expected_score_played, expected_score_loss,
         best_move_uci, best_move_san, best_line_id, tags_json, explanation, engine, engine_version, algorithm_version,
         verified, reduced, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, ply) DO UPDATE SET
         mover = excluded.mover, played_move_san = excluded.played_move_san, played_move_uci = excluded.played_move_uci,
         classification = excluded.classification, badges_json = excluded.badges_json,
         evaluation_before = excluded.evaluation_before, evaluation_after = excluded.evaluation_after,
         expected_score_best = excluded.expected_score_best, expected_score_played = excluded.expected_score_played,
         expected_score_loss = excluded.expected_score_loss, best_move_uci = excluded.best_move_uci,
         best_move_san = excluded.best_move_san, best_line_id = excluded.best_line_id, tags_json = excluded.tags_json,
         explanation = excluded.explanation, engine = excluded.engine, engine_version = excluded.engine_version,
         algorithm_version = excluded.algorithm_version, verified = excluded.verified, reduced = excluded.reduced,
         created_at = excluded.created_at`,
    );
    const save = this.db.transaction(() => {
      for (const r of reviews) {
        stmt.run(
          crypto.randomUUID(),
          r.gameId,
          r.ply,
          r.mover,
          r.playedMoveSan,
          r.playedMoveUci,
          r.classification,
          json(r.badges),
          json(r.evaluationBefore),
          json(r.evaluationAfter),
          r.expectedScoreBest,
          r.expectedScorePlayed,
          r.expectedScoreLoss,
          r.bestMoveUci,
          r.bestMoveSan,
          r.bestLineId,
          json(r.tags),
          r.explanation,
          r.engine,
          r.engineVersion,
          r.algorithmVersion,
          r.verified ? 1 : 0,
          r.reduced ? 1 : 0,
          now(),
        );
      }
    });
    save();
  }

  getReviews(gameId: string): MoveReview[] {
    return (this.db.prepare("SELECT * FROM move_reviews WHERE game_id = ? ORDER BY ply").all(gameId) as Row[]).map(
      toReview,
    );
  }

  getReview(gameId: string, ply: number): MoveReview | null {
    const row = this.db
      .prepare("SELECT * FROM move_reviews WHERE game_id = ? AND ply = ?")
      .get(gameId, ply) as Row | undefined;
    return row ? toReview(row) : null;
  }

  // ---- variations (persisted only on explicit user save) ----

  saveVariation(v: Omit<Variation, "saved">): void {
    this.db
      .prepare(
        "INSERT INTO variations (id, game_id, starting_ply, type, created_by, moves_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(v.id, v.gameId, v.startingPly, v.type, v.createdBy, json(v.moves), now());
  }

  listVariations(gameId: string): Variation[] {
    return (this.db.prepare("SELECT * FROM variations WHERE game_id = ? ORDER BY created_at").all(gameId) as Row[]).map(
      (r) => ({
        id: String(r.id),
        gameId: String(r.game_id),
        startingPly: Number(r.starting_ply),
        type: String(r.type) as Variation["type"],
        createdBy: String(r.created_by) as Variation["createdBy"],
        moves: parse(r.moves_json),
        saved: true,
      }),
    );
  }

  countVariations(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM variations").get() as Row).n);
  }

  // ---- settings ----

  getSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value_json FROM settings").all() as Row[];
    const stored = Object.fromEntries(rows.map((r) => [String(r.key), parse(r.value_json)]));
    return { ...DEFAULT_SETTINGS, ...stored } as Settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    );
    const save = this.db.transaction(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, json(v));
    });
    save();
    return this.getSettings();
  }

  // ---- Chess.com HTTP cache ----

  getSyncCache(url: string): { etag: string | null; lastModified: string | null } | null {
    const row = this.db.prepare("SELECT * FROM sync_cache WHERE url = ?").get(url) as Row | undefined;
    return row ? { etag: (row.etag as string) ?? null, lastModified: (row.last_modified as string) ?? null } : null;
  }

  putSyncCache(url: string, etag: string | null, lastModified: string | null): void {
    this.db
      .prepare(
        `INSERT INTO sync_cache (url, etag, last_modified, last_checked) VALUES (?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, last_checked = excluded.last_checked`,
      )
      .run(url, etag, lastModified, now());
  }

  touchSyncCache(url: string): void {
    this.db.prepare("UPDATE sync_cache SET last_checked = ? WHERE url = ?").run(now(), url);
  }

  addImportFailure(f: ImportFailure): void {
    this.db
      .prepare("INSERT INTO import_failures (profile_id, archive_url, source_game_id, error, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(f.profileId, f.archiveUrl, f.sourceGameId, f.error.slice(0, 500), now());
  }

  // ---- MCP audit log (spec §53) ----

  addAudit(entry: Omit<AuditEntry, "id" | "timestamp">): void {
    this.db
      .prepare("INSERT INTO mcp_audit (timestamp, tool, game_id, ply, line_id, result) VALUES (?, ?, ?, ?, ?, ?)")
      .run(now(), entry.tool, entry.gameId, entry.ply, entry.lineId, entry.result);
  }

  listAudit(limit = 100): AuditEntry[] {
    return (this.db.prepare("SELECT * FROM mcp_audit ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: Number(r.id),
      timestamp: String(r.timestamp),
      tool: String(r.tool),
      gameId: (r.game_id as string) ?? null,
      ply: numOrNull(r.ply),
      lineId: (r.line_id as string) ?? null,
      result: String(r.result),
    }));
  }
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function numOrUndef(v: unknown): number | undefined {
  return v === null || v === undefined ? undefined : Number(v);
}

function toProfile(r: Row): Profile {
  return {
    id: String(r.id),
    source: "chesscom",
    username: String(r.username),
    createdAt: String(r.created_at),
    lastSyncAt: (r.last_sync_at as string) ?? null,
  };
}

function toGame(r: Row): Game {
  return {
    id: String(r.id),
    profileId: (r.profile_id as string) ?? null,
    source: "chesscom",
    sourceGameId: String(r.source_game_id),
    url: (r.url as string) ?? null,
    white: { username: String(r.white_username), rating: numOrNull(r.white_rating) },
    black: { username: String(r.black_username), rating: numOrNull(r.black_rating) },
    result: String(r.result) as Game["result"],
    playedAt: String(r.played_at),
    timeControl: String(r.time_control),
    timeClass: String(r.time_class) as TimeClass,
    eco: (r.eco as string) ?? null,
    openingName: (r.opening_name as string) ?? null,
    variant: String(r.variant),
    supported: !!r.supported,
    userColour: (r.user_colour as Colour) ?? null,
    pgn: String(r.pgn),
    plyCount: Number(r.ply_count),
    createdAt: String(r.created_at),
  };
}

function toMove(r: Row): GameMove {
  return {
    gameId: String(r.game_id),
    ply: Number(r.ply),
    san: String(r.san),
    uci: String(r.uci),
    fenBefore: String(r.fen_before),
    fenAfter: String(r.fen_after),
  };
}

function toLine(r: Row): EngineLine {
  return {
    id: String(r.id),
    rank: Number(r.rank),
    rootMoveUci: String(r.root_move_uci),
    rootMoveSan: String(r.root_move_san),
    evaluation: parse(r.evaluation),
    wdl: r.wdl_json ? parse(r.wdl_json) : undefined,
    moves: parse(r.moves_json),
  };
}

function toReview(r: Row): MoveReview {
  return {
    gameId: String(r.game_id),
    ply: Number(r.ply),
    mover: String(r.mover) as Colour,
    playedMoveSan: String(r.played_move_san),
    playedMoveUci: String(r.played_move_uci),
    classification: String(r.classification) as MoveReview["classification"],
    badges: parse(r.badges_json),
    evaluationBefore: parse(r.evaluation_before),
    evaluationAfter: parse(r.evaluation_after),
    expectedScoreBest: numOrNull(r.expected_score_best),
    expectedScorePlayed: numOrNull(r.expected_score_played),
    expectedScoreLoss: numOrNull(r.expected_score_loss),
    bestMoveSan: (r.best_move_san as string) ?? null,
    bestMoveUci: (r.best_move_uci as string) ?? null,
    bestLineId: (r.best_line_id as string) ?? null,
    tags: parse(r.tags_json),
    explanation: String(r.explanation),
    engine: String(r.engine),
    engineVersion: String(r.engine_version),
    algorithmVersion: Number(r.algorithm_version),
    verified: !!r.verified,
    reduced: !!r.reduced,
  };
}
