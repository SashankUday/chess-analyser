import type { AnalysisPresetName, MoveClassification, Palette, Settings } from "./types";

export const APP_NAME = "ChessAnalyser";
export const APP_VERSION = "0.1.0";
/** Set this to the public GitHub URL once the repository is published; it is used in the Chess.com User-Agent. */
export const REPOSITORY_URL = "https://github.com/SashankUday/chess-analyser";

/** Bumped whenever classification rules change (spec §67). */
export const REVIEW_ALGORITHM_VERSION = 2;

// ---------------- Review Algorithm 2 calibration constants (V2 plan §8, §11–17) ----------------

/** Same-root analysis lines per position. */
export const REVIEW_MULTIPV = 3;

/** Result-class boundaries on mover Win% (0–100). */
export const RESULT_CLASS_BANDS = {
  winning: 85,
  advantage: 65,
  disadvantage: 35,
  losing: 15,
} as const;

/** Win%-loss bands (percentage points). A move is labelled by the first bound it is below. */
export const WIN_LOSS_BANDS = {
  excellent: 2,
  good: 5,
  inaccuracy: 10,
  mistake: 20,
} as const;

/** Centipawn guards for Excellent/Good while the game is still undecided. */
export const CP_LOSS_GUARDS = {
  excellent: 50,
  good: 100,
} as const;

/** A non-top move counts as Best only when verified to be this close to rank 1. */
export const BEST_EQUIVALENCE = {
  maxWinPercentLoss: 0.5,
  maxCpLoss: 10,
} as const;

/** When a preliminary result triggers a deeper same-root verification. */
export const VERIFICATION = {
  nodes: 1_000_000,
  multiPv: 3,
  cpLoss: 100,
  /** Win%-loss distance from a band boundary that counts as borderline. */
  boundaryMargin: 1,
  /** Material swing (pawns) in the played line that warrants a recheck. */
  materialSwing: 3,
} as const;

/** Great: rank-1 moves that are uniquely strong (V2 plan §16–17). */
export const GREAT = {
  /** Win% gap to the second-best move that makes a move "the only move". (Calibrated: 12 → 15.) */
  onlyMoveGap: 15,
  /** A smaller gap suffices when the move also improves the result class. (Calibrated: 6 → 10.) */
  transitionGap: 10,
  /** Skip already-decided positions (mover Win% above this) — no move there is uniquely critical. */
  maxWinPercentBefore: 95,
  /** A capture that wins at least this much material by plain exchange is an obvious grab, not Great. */
  obviousCaptureGain: 2,
} as const;

/** "Loses major material by force without compensation" (V2 plan §13). */
export const MATERIAL_OVERRIDE = {
  /** Net material lost in the played line (pawns) that counts as major. */
  minLoss: 5,
  /** The engine's centipawn loss must cover at least this share of the material's value. */
  minCpShare: 0.8,
} as const;

/** Miss badges (V2 plan §24). */
export const MISS = {
  /** Material (pawns) the best line wins by force that the played move gives up. */
  materialWin: 2,
} as const;

/** Threat detection budget for "if it were their move" searches. */
export const THREAT_SEARCH = {
  nodes: 50_000,
  maxMateIn: 3,
  materialThreshold: 2,
} as const;

/** Moves shown in a best line / continuation (6–10 plies). */
export const LINE_DISPLAY_PLIES = 10;

/** Expected-outcome-loss thresholds (spec §11). A move is labelled by the first bound it does not exceed. */
export const CLASSIFICATION_THRESHOLDS: ReadonlyArray<{ max: number; classification: MoveClassification }> = [
  { max: 0.005, classification: "best" },
  { max: 0.02, classification: "excellent" },
  { max: 0.05, classification: "good" },
  { max: 0.1, classification: "inaccuracy" },
  { max: 0.2, classification: "mistake" },
];
export const BLUNDER_FALLBACK: MoveClassification = "blunder";

/** Losses within this distance of a threshold trigger a like-for-like recheck. */
export const BORDERLINE_MARGIN = 0.01;
export const BORDERLINE_MIN_NODES = 1_000_000;

/** A "missed win" badge: the mover's best expected score was at least this, and the played move dropped below. */
export const MISSED_WIN_FROM = 0.8;
export const MISSED_WIN_TO = 0.6;

export const BRILLIANT = {
  maxLoss: 0.015,
  /** Minimum apparent material concession, in pawns (a minor piece or the exchange). */
  minConcession: 2,
  /** A smaller concession (a pawn) is enough only when the sacrifice leads to forced mate. */
  minConcessionForMate: 1,
  /** In an already-won (non-mating) position the sacrifice must also be the only move: Win% gap. */
  winningOnlyMoveGap: 12,
  /** In a forced-mate position only a real piece sacrifice (pawns) is brilliant. */
  mateSacrificeMin: 3,
  /** How many plies of the principal variation to scan for a material dip. */
  pvScanPlies: 4,
  verificationNodes: 1_000_000,
  verificationMultiPv: 3,
} as const;

/**
 * Reduced review (Apple Chess/Sjeng) has no calibrated WDL. It criticises moves by centipawn loss
 * only when the position is within ±3 pawns (or the move flips the evaluation), never awards
 * Brilliant/Excellent, and labels uncritical non-best moves neutrally as Good.
 */
export const SJENG_CP_THRESHOLDS = {
  evalWindowCp: 300,
  /** Maximum centipawn loss for each label; anything larger is a Blunder. */
  best: 20,
  good: 60,
  inaccuracy: 150,
  mistake: 300,
} as const;

export interface AnalysisPreset {
  name: AnalysisPresetName;
  nodes: number;
  multiPv: number;
}

export const ANALYSIS_PRESETS: Record<AnalysisPresetName, AnalysisPreset> = {
  quick: { name: "quick", nodes: 50_000, multiPv: 1 },
  standard: { name: "standard", nodes: 200_000, multiPv: 1 },
  deep: { name: "deep", nodes: 1_000_000, multiPv: 3 },
};

/** Sjeng has no node limit over xboard; it is given a time budget per position instead. */
export const SJENG_SECONDS_PER_PRESET: Record<AnalysisPresetName, number> = {
  quick: 1,
  standard: 2,
  deep: 5,
};

export const ENGINE_DEFAULTS = {
  hashMb: 256,
  maxThreads: 4,
  /** Send `ucinewgame` before each independent cached search so results don't depend on search order. */
  isolateSearches: true,
} as const;

/** Eval-bar and graph clamps (spec §7–8). */
export const EVAL_GRAPH_CAP_PAWNS = 10;

export const DEFAULT_SETTINGS: Settings = {
  palette: "navy",
  defaultPreset: "standard",
  threads: "auto",
  hashMb: ENGINE_DEFAULTS.hashMb,
  stockfishPath: null,
  chesscomUsername: null,
};

export const PALETTES: ReadonlyArray<{ id: Palette; label: string }> = [
  { id: "navy", label: "Navy" },
  { id: "orange", label: "Orange" },
  { id: "pink", label: "Pink" },
];

export const CLASSIFICATION_ORDER: MoveClassification[] = [
  "brilliant",
  "great",
  "best",
  "excellent",
  "good",
  "inaccuracy",
  "mistake",
  "blunder",
  "forced",
];

export const CLASSIFICATION_LABELS: Record<MoveClassification, string> = {
  brilliant: "Brilliant",
  great: "Great",
  best: "Best",
  excellent: "Excellent",
  good: "Good",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
  forced: "Forced",
};

export const CLASSIFICATION_SYMBOLS: Partial<Record<MoveClassification, string>> = {
  brilliant: "!!",
  great: "!",
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
};

export const STALE_SESSION = "STALE_SESSION";
export const AI_ACCESS_DENIED = "AI_ACCESS_DENIED";
