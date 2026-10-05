import crypto from "node:crypto";
import { terminalState } from "@chessanalyser/chess-core";
import { exactWdl, type EngineAnalysis, type EngineStatus, type JobKind } from "@chessanalyser/shared";
import type { EnsuredEngine } from "./ensure";
import { AbortError, EngineCrashedError, type AnalysisOptions, type ChessEngine, type EngineIdentity } from "./types";
import { configHash } from "./uci";

/** Interactive > AI candidate / verification > full-game background (spec §21). */
export const JOB_PRIORITY: Record<JobKind, number> = {
  POSITION: 30,
  DEEP_ANALYSIS: 30,
  CANDIDATE: 20,
  BRILLIANT_VERIFICATION: 20,
  CLASSIFICATION_VERIFICATION: 20,
  FULL_GAME: 10,
};

export interface AnalysisCache {
  get(fen: string, configHash: string): EngineAnalysis | null;
  put(analysis: EngineAnalysis, config: Record<string, unknown>): void;
}

export interface AnalyseRequest {
  kind: JobKind;
  preset: EngineAnalysis["preset"];
  nodes: number;
  multiPv: number;
  seconds?: number;
  searchMoves?: string[];
  /** Tasks sharing a job id can be cancelled together. */
  jobId?: string;
}

export class EngineUnavailableError extends Error {
  constructor(message = "No chess engine is available.") {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

export class EnginePausedError extends Error {
  constructor(message = "Stockfish stopped unexpectedly. Analysis was paused.") {
    super(message);
    this.name = "EnginePausedError";
  }
}

interface Task {
  seq: number;
  priority: number;
  jobId?: string;
  fen: string;
  options: AnalysisOptions;
  controller: AbortController;
  retried: boolean;
  resolve: (a: EngineAnalysis) => void;
  reject: (e: Error) => void;
}

/**
 * Owns the single engine process and its work queue (spec §21). Full-game analysis is submitted one
 * position at a time, so interactive requests overtake it between positions.
 */
export class EngineManager {
  private engine: ChessEngine | null = null;
  private identity_: EngineIdentity | null = null;
  private status_: EngineStatus = { state: "checking" };
  private readyStatus: EngineStatus | null = null;
  private queue: Task[] = [];
  private running: Task | null = null;
  private seq = 0;
  private paused = false;
  private inflight = new Map<string, Promise<EngineAnalysis>>();
  private statusListeners = new Set<(s: EngineStatus) => void>();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private isReady = false;

  constructor(private readonly cache: AnalysisCache | null) {
    this.readyPromise = new Promise((r) => (this.resolveReady = r));
  }

  get status(): EngineStatus {
    return this.status_;
  }

  get identity(): EngineIdentity | null {
    return this.identity_;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  onStatus(listener: (s: EngineStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  setStatus(status: EngineStatus): void {
    this.status_ = status;
    for (const l of this.statusListeners) l(status);
  }

  /** Install the result of `ensureEngine`, replacing any previous engine. */
  async setEngine(ensured: EnsuredEngine): Promise<void> {
    const previous = this.engine;
    this.engine = ensured.engine;
    this.identity_ = ensured.identity;
    this.paused = false;
    this.readyStatus = ensured.status.state === "ready" ? ensured.status : null;
    this.setStatus(ensured.status);
    this.isReady = true;
    this.resolveReady();
    if (previous && previous !== ensured.engine) await previous.dispose().catch(() => undefined);
    this.pump();
  }

  /** Wait (bounded) until the first engine lookup has finished. */
  async whenReady(timeoutMs = 10 * 60_000): Promise<void> {
    await Promise.race([this.readyPromise, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.readyStatus) this.setStatus(this.readyStatus);
    this.pump();
  }

  /** The cache key a request would use, so callers can look up results without searching. */
  configFor(request: AnalyseRequest): { config: Record<string, unknown>; hash: string } | null {
    if (!this.engine) return null;
    const config = this.engine.searchConfig(this.toOptions(request));
    return { config, hash: configHash(config) };
  }

  cached(fen: string, request: AnalyseRequest): EngineAnalysis | null {
    const key = this.configFor(request);
    if (!key || !this.cache) return null;
    const hit = this.cache.get(fen, key.hash);
    return hit && this.usable(hit) ? hit : null;
  }

  async analyse(fen: string, request: AnalyseRequest): Promise<EngineAnalysis> {
    // Only yield while the engine is still being located, so concurrent calls dedupe and can be cancelled.
    if (!this.isReady) await this.whenReady();
    if (!this.engine || !this.identity_) throw new EngineUnavailableError();

    const terminal = terminalState(fen);
    if (terminal) return this.terminalAnalysis(fen, request, terminal);

    const key = this.configFor(request)!;
    const hit = this.cache?.get(fen, key.hash);
    if (hit && this.usable(hit)) return hit;

    if (this.paused) throw new EnginePausedError();

    const flightKey = `${fen}|${key.hash}`;
    const existing = this.inflight.get(flightKey);
    if (existing) return existing;

    const promise = new Promise<EngineAnalysis>((resolve, reject) => {
      this.queue.push({
        seq: this.seq++,
        priority: JOB_PRIORITY[request.kind],
        jobId: request.jobId,
        fen,
        options: this.toOptions(request),
        controller: new AbortController(),
        retried: false,
        resolve,
        reject,
      });
    })
      .then((raw) => {
        const analysis = { ...raw, configHash: key.hash };
        this.cache?.put(analysis, key.config);
        return analysis;
      })
      .finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, promise);
    this.pump();
    return promise;
  }

  cancelJob(jobId: string): void {
    const keep: Task[] = [];
    for (const t of this.queue) {
      if (t.jobId === jobId) t.reject(new AbortError());
      else keep.push(t);
    }
    this.queue = keep;
    if (this.running?.jobId === jobId) this.running.controller.abort();
  }

  async dispose(): Promise<void> {
    for (const t of this.queue.splice(0)) t.reject(new AbortError("Shutting down."));
    this.running?.controller.abort();
    await this.engine?.dispose().catch(() => undefined);
    this.engine = null;
  }

  /** A Stockfish row without WDL is unusable for review; it is reanalysed, never converted. */
  private usable(a: EngineAnalysis): boolean {
    if (a.evaluation.terminal) return true;
    if (a.capabilities.wdl && !a.wdl) return false;
    return a.lines.length > 0;
  }

  private toOptions(request: AnalyseRequest): AnalysisOptions {
    return {
      preset: request.preset,
      nodes: request.nodes,
      multiPv: request.multiPv,
      searchMoves: request.searchMoves,
      seconds: request.seconds,
    };
  }

  private terminalAnalysis(
    fen: string,
    request: AnalyseRequest,
    terminal: NonNullable<ReturnType<typeof terminalState>>,
  ): EngineAnalysis {
    const id = this.identity_!;
    const evaluation = { whiteCp: null, mateForWhiteIn: null, terminal };
    return {
      id: crypto.randomUUID(),
      engine: id.kind === "stockfish" ? "Stockfish" : id.name,
      engineVersion: id.version,
      capabilities: id.capabilities,
      fen,
      preset: request.preset,
      configHash: "terminal",
      evaluation,
      wdl: id.capabilities.wdl ? (exactWdl(evaluation) ?? undefined) : undefined,
      lines: [],
      createdAt: new Date().toISOString(),
    };
  }

  private pump(): void {
    if (this.running || this.paused || !this.engine || this.queue.length === 0) return;
    let bestIdx = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i]!;
      const b = this.queue[bestIdx]!;
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) bestIdx = i;
    }
    const task = this.queue.splice(bestIdx, 1)[0]!;
    this.running = task;
    void this.run(task);
  }

  private async run(task: Task): Promise<void> {
    const engine = this.engine!;
    try {
      const result = await engine.analysePosition({ fen: task.fen }, { ...task.options, signal: task.controller.signal });
      task.resolve(result);
    } catch (err) {
      if (err instanceof EngineCrashedError && !task.retried) {
        // Restart once automatically: the adapter respawns on its next call.
        task.retried = true;
        this.queue.unshift(task);
      } else if (err instanceof EngineCrashedError) {
        this.paused = true;
        task.reject(new EnginePausedError());
        for (const t of this.queue.splice(0)) t.reject(new EnginePausedError());
        this.setStatus({ state: "unavailable", error: "Stockfish stopped unexpectedly. Analysis was paused." });
      } else {
        task.reject(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.running = null;
      this.pump();
    }
  }
}
