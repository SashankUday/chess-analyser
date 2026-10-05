// Canonical ChessAnalyser types (spec §29–32). The backend owns these; the web UI and MCP consume them.

export type GameId = string;
export type PositionId = string;
export type AnalysisId = string;
export type EngineLineId = string;
export type VariationId = string;
export type ProfileId = string;
export type JobId = string;

export type Colour = "white" | "black";
export type GameResult = "1-0" | "0-1" | "1/2-1/2" | "*";
export type TimeClass = "bullet" | "blitz" | "rapid" | "classical" | "daily" | "unknown";

export interface Player {
  username: string;
  rating: number | null;
}

export interface Profile {
  id: ProfileId;
  source: "chesscom";
  username: string;
  createdAt: string;
  lastSyncAt: string | null;
}

export interface Game {
  id: GameId;
  profileId: ProfileId | null;
  source: "chesscom";
  sourceGameId: string;
  url: string | null;
  white: Player;
  black: Player;
  result: GameResult;
  playedAt: string;
  timeControl: string;
  timeClass: TimeClass;
  eco: string | null;
  openingName: string | null;
  variant: string;
  /** False for Chess960 and other variants (spec §26). */
  supported: boolean;
  /** Which side the imported profile played, used for default board orientation. */
  userColour: Colour | null;
  pgn: string;
  plyCount: number;
  createdAt: string;
}

export interface GameSummary extends Omit<Game, "pgn"> {
  analysed: boolean;
}

export interface GameMove {
  gameId: GameId;
  /** Ply N transforms position N−1 into position N. The first move is ply 1. */
  ply: number;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
}

/** White-point-of-view evaluation. Never side-to-move relative once it leaves the engine adapter. */
export interface NormalisedEvaluation {
  whiteCp: number | null;
  /** Positive: White mates in N moves. Negative: Black mates in N moves. */
  mateForWhiteIn: number | null;
  /** Set when the position itself is already over (checkmate, stalemate, dead position). */
  terminal?: TerminalState;
}

export interface TerminalState {
  kind: "checkmate" | "stalemate" | "insufficient_material";
  winner: Colour | null;
}

/** Probabilities (0–1) from White's point of view. */
export interface Wdl {
  whiteWin: number;
  draw: number;
  blackWin: number;
}

export interface VariationMove {
  san: string;
  uci: string;
  fenAfter: string;
}

export interface EngineLine {
  id: EngineLineId;
  rank: number;
  rootMoveUci: string;
  rootMoveSan: string;
  evaluation: NormalisedEvaluation;
  wdl?: Wdl;
  moves: VariationMove[];
}

export type EngineKind = "stockfish" | "sjeng" | "mock";

export interface EngineCapabilities {
  wdl: boolean;
  multipv: boolean;
}

export type AnalysisPresetName = "quick" | "standard" | "deep";

export interface EngineAnalysis {
  id: AnalysisId;
  engine: string;
  engineVersion: string;
  capabilities: EngineCapabilities;
  fen: string;
  preset: AnalysisPresetName | "verification" | "custom";
  configHash: string;
  nodes?: number;
  depth?: number;
  evaluation: NormalisedEvaluation;
  wdl?: Wdl;
  lines: EngineLine[];
  createdAt: string;
}

export type MoveClassification =
  | "brilliant"
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "forced";

export type MoveBadge = "missed_mate" | "allows_mate" | "missed_win" | "wins_material" | "loses_material";

export type TacticalTag =
  | "hangs_piece"
  | "wins_material"
  | "loses_material"
  | "misses_capture"
  | "allows_mate"
  | "misses_mate"
  | "creates_mate_threat"
  | "allows_fork"
  | "back_rank_weakness"
  | "removes_defender";

export interface MoveReview {
  gameId: GameId;
  ply: number;
  mover: Colour;

  playedMoveSan: string;
  playedMoveUci: string;

  classification: MoveClassification;
  badges: MoveBadge[];

  evaluationBefore: NormalisedEvaluation;
  evaluationAfter: NormalisedEvaluation;

  /** Null in reduced (non-WDL) review mode. */
  expectedScoreBest: number | null;
  expectedScorePlayed: number | null;
  expectedScoreLoss: number | null;

  bestMoveSan: string | null;
  bestMoveUci: string | null;
  bestLineId: EngineLineId | null;

  tags: TacticalTag[];
  explanation: string;

  engine: string;
  engineVersion: string;
  algorithmVersion: number;
  /** True when the label was confirmed by a targeted like-for-like recheck. */
  verified: boolean;
  /** True when produced without WDL (Apple Chess/Sjeng fallback). */
  reduced: boolean;
}

export interface ReviewSummary {
  white: Record<MoveClassification, number>;
  black: Record<MoveClassification, number>;
}

export interface GameReview {
  gameId: GameId;
  complete: boolean;
  reviews: MoveReview[];
  /** Per-position evaluation, index = ply (0 = start position). Null when not yet analysed. */
  positions: (PositionEvaluation | null)[];
  summary: ReviewSummary;
}

export interface PositionEvaluation {
  ply: number;
  fen: string;
  evaluation: NormalisedEvaluation;
  wdl?: Wdl;
  bestLine?: EngineLine;
  engine: string;
}

export type VariationType = "engine" | "user" | "ai_selected";

export interface Variation {
  id: VariationId;
  gameId: GameId;
  /** The ply of the position the variation branches from (0 = start position). */
  startingPly: number;
  type: VariationType;
  createdBy: "user" | "engine" | "ai";
  moves: VariationMove[];
  saved: boolean;
}

export type Palette = "navy" | "orange" | "pink";

export interface Settings {
  palette: Palette;
  defaultPreset: AnalysisPresetName;
  threads: "auto" | number;
  hashMb: number;
  stockfishPath: string | null;
  chesscomUsername: string | null;
}

export type AiAccess = { mode: "off" } | { mode: "current_game"; gameId: GameId } | { mode: "library" };

export type EngineStatus =
  | { state: "checking" }
  | { state: "installing"; message: string; progress?: number }
  | {
      state: "ready";
      kind: EngineKind;
      name: string;
      version: string;
      path: string;
      source: "env" | "managed" | "path" | "downloaded" | "sjeng" | "mock";
      fallback: boolean;
    }
  | { state: "unavailable"; error: string; downloadFailed?: boolean; detectedFallback?: boolean };

export type JobKind =
  | "FULL_GAME"
  | "POSITION"
  | "CANDIDATE"
  | "BRILLIANT_VERIFICATION"
  | "CLASSIFICATION_VERIFICATION"
  | "DEEP_ANALYSIS";

export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "paused";

export interface JobInfo {
  id: JobId;
  kind: JobKind;
  gameId: GameId | null;
  state: JobState;
  done: number;
  total: number;
  error?: string;
}

/** Frontend board state machine (spec §68). */
export type BoardMode =
  | { type: "game"; gameId: GameId; ply: number }
  | { type: "engineVariation"; lineId: EngineLineId; index: number }
  | { type: "userVariation"; variationId: VariationId; index: number };

export type OverlayRole = "primary" | "warning" | "danger";

export interface Arrow {
  from: string;
  to: string;
  role: OverlayRole;
}

export interface SquareHighlight {
  square: string;
  role: OverlayRole;
}
