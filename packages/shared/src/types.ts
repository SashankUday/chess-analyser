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
  | "great"
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "forced";

export type MoveBadge =
  | "missed_mate"
  | "allows_mate"
  | "missed_win"
  | "missed_material"
  | "wins_material"
  | "loses_material"
  | "only_move";

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
  /** Review Algorithm 2 detail (absent on V1 reviews). */
  v2?: MoveReviewV2Details;
}

// ---------------- Review Algorithm 2 ----------------

export type ResultClass =
  | "FORCED_WIN"
  | "WINNING"
  | "ADVANTAGE"
  | "EQUAL"
  | "DISADVANTAGE"
  | "LOSING"
  | "FORCED_LOSS";

/** A root move compared from the pre-move position. All scores are mover-relative. */
export interface RootMoveScore {
  san: string;
  uci: string;
  cp: number;
  winPercent: number;
  rank: number | null;
}

/** Same-root move-quality measurement (V2 plan §10). Mover-relative throughout. */
export interface MoveQualityMetrics {
  bestCp: number;
  playedCp: number;
  cpLoss: number;
  bestWinPercent: number;
  playedWinPercent: number;
  winPercentLoss: number;
  /** 1-based rank among the engine's MultiPV lines; null when outside them. */
  playedRank: number | null;
  resultClassBefore: ResultClass;
  resultClassAfter: ResultClass;
  /** Win% gap between the best and second-best move; null with fewer than two legal moves. */
  criticality: number | null;
  /** True when the played move's score came from the same root search as the best move's. */
  sameSearch: boolean;
  nodes: number;
  rootMoves: RootMoveScore[];
}

export interface TacticalMove {
  san: string;
  uci: string;
  /** Net material gain in pawns (static exchange), for captures. */
  gain?: number;
}

export type ThreatKind = "mate" | "material" | "promotion" | "fork";

export interface Threat {
  kind: ThreatKind;
  /** The side making the threat. */
  side: Colour;
  san: string;
  uci: string;
  description: string;
  /** Material at stake in pawns, when applicable. */
  value?: number;
  confidence: "forced" | "high" | "medium";
}

export interface MateThreat {
  side: Colour;
  mateIn: number;
  firstMove: string;
  firstMoveUci: string;
  /** Engine line id of the threat search (a hypothetical "if it were their move" position). */
  lineId: string | null;
  line: string[];
  /** "forced": a verified mate; "attack": a strong but unverified mating attack. */
  confidence: "forced" | "attack";
}

export interface HangingPiece {
  square: string;
  piece: string;
  colour: Colour;
  /** Material the opponent would win, in pawns. */
  value: number;
}

export interface ForcedMaterialSequence {
  /** The side that comes out ahead. */
  side: Colour;
  amount: number;
  /** What is lost, e.g. "a bishop", "the exchange". */
  description: string;
  /** Plies until the material is won and kept. */
  plies: number;
  immediate: boolean;
  /** SAN moves of the demonstrating line, starting from the position it describes. */
  line: string[];
  lineId: string | null;
  firstPly: number;
}

export interface PositionInsights {
  sideToMove: Colour;
  inCheck: boolean;
  checks: TacticalMove[];
  captures: TacticalMove[];
  /** Threats by the side NOT to move (what they would do if it were their turn). */
  threats: Threat[];
  mateThreat?: MateThreat;
  hangingPieces: HangingPiece[];
  forcedMaterialGain?: ForcedMaterialSequence;
  forcedMaterialLoss?: ForcedMaterialSequence;
  criticality: number | null;
}

export interface MoveExplanation {
  headline: string;
  summary: string;
  positionChange?: string;
  threatBefore?: string;
  consequence?: string;
  bestMoveReason?: string;
  /** Engine line demonstrating the consequence (starts at `lineStartPly`). */
  lineId?: string;
  line?: string;
  lineStartPly?: number;
  confidence: "high" | "medium" | "low";
}

export interface DiagnosticCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface BrilliantDiagnostics {
  candidate: boolean;
  checks: DiagnosticCheck[];
  result: boolean;
  sacrifice?: { amount: number; kind: string; acceptSan: string | null };
}

export interface ReviewEngineConfig {
  engine: string;
  version: string;
  network?: string;
  nodes: number;
  verificationNodes: number;
  multiPv: number;
  threads?: number;
  hashMb?: number;
}

export interface ReviewDiagnostics {
  preliminaryClassification: MoveClassification;
  preliminaryMetrics: MoveQualityMetrics;
  verificationReasons: string[];
  overrides: string[];
  brilliant?: BrilliantDiagnostics;
  great?: DiagnosticCheck[];
}

export interface MoveReviewV2Details {
  metrics: MoveQualityMetrics;
  insightsBefore: PositionInsights | null;
  insightsAfter: PositionInsights | null;
  explanation: MoveExplanation;
  diagnostics: ReviewDiagnostics;
  engineConfig: ReviewEngineConfig;
  /** Engine line of the played move from the same root (starts with the played move). */
  playedLineId: string | null;
}

export interface ReviewSummary {
  white: Record<MoveClassification, number>;
  black: Record<MoveClassification, number>;
}

export interface GameReview {
  gameId: GameId;
  complete: boolean;
  /** Lowest review algorithm version among the stored reviews (null when not reviewed). */
  algorithmVersion: number | null;
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
  /** The variation this one branched from, when created by playing a different move mid-line. */
  parentId: VariationId | null;
  /** Number of the parent's moves shared before this branch diverges. */
  branchIndex: number | null;
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
