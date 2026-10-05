import type { AnalysisPresetName, MoveClassification, Palette, Settings } from "./types";

export const APP_NAME = "ChessAnalyser";
export const APP_VERSION = "0.1.0";
/** Set this to the public GitHub URL once the repository is published; it is used in the Chess.com User-Agent. */
export const REPOSITORY_URL = "https://github.com/SashankUday/chess-analyser";

/** Bumped whenever classification rules change (spec §67). */
export const REVIEW_ALGORITHM_VERSION = 1;

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
  /** Minimum apparent material concession, in pawns. */
  minConcession: 1,
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
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
};

export const STALE_SESSION = "STALE_SESSION";
export const AI_ACCESS_DENIED = "AI_ACCESS_DENIED";
