import type { EngineAnalysis, EngineCapabilities, EngineKind } from "@chessanalyser/shared";

export interface EngineIdentity {
  kind: EngineKind;
  /** Display name, e.g. "Stockfish 19" or "Apple Chess (Sjeng 11.2)". */
  name: string;
  version: string;
  path: string;
  capabilities: EngineCapabilities;
  /** NNUE network file name (Stockfish), used in the cache key. */
  network?: string;
  /** SHA-256 of the engine binary, used in the cache key. */
  binarySha256?: string;
}

export interface Position {
  fen: string;
}

export interface AnalysisOptions {
  /** Display label stored with the result; not part of the cache key. */
  preset: EngineAnalysis["preset"];
  nodes: number;
  multiPv: number;
  /** Restrict the root search to these UCI moves (Stockfish `go searchmoves`). */
  searchMoves?: string[];
  /** Sjeng has no node limit; seconds per position instead. */
  seconds?: number;
  signal?: AbortSignal;
}

export interface ChessEngine {
  identify(): Promise<EngineIdentity>;
  /**
   * The exact settings a search with these options would use. Its canonical hash is the analysis
   * cache key, so anything that can change the search result must appear here (spec §22).
   */
  searchConfig(options: AnalysisOptions): Record<string, unknown>;
  analysePosition(position: Position, options: AnalysisOptions): Promise<EngineAnalysis>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export class EngineCrashedError extends Error {
  constructor(message = "The engine process exited unexpectedly.") {
    super(message);
    this.name = "EngineCrashedError";
  }
}

export class AbortError extends Error {
  constructor(message = "Analysis was cancelled.") {
    super(message);
    this.name = "AbortError";
  }
}
