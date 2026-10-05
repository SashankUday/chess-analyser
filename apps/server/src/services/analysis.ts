import crypto from "node:crypto";
import { parseMove } from "@chessanalyser/chess-core";
import type { ChessDb } from "@chessanalyser/database";
import { AbortError, EnginePausedError, EngineUnavailableError } from "@chessanalyser/engine";
import { reviewGame, summarise, type ReviewEngine } from "@chessanalyser/review";
import {
  REVIEW_MULTIPV,
  THREAT_SEARCH,
  VERIFICATION,
  type AnalysisPresetName,
  type EngineAnalysis,
  type GameReview,
  type JobInfo,
  type JobKind,
  type PositionEvaluation,
  type VariationMove,
} from "@chessanalyser/shared";
import { HttpError, badRequest, notFound } from "../errors";
import type { Logger } from "../logger";
import type { EngineService } from "./engine";
import type { GameService } from "./games";
import type { UiSessionService } from "./ui-sessions";

/** Game analysis and Game Review (spec §42). Results stream to the browser as positions finish. */
export class AnalysisService {
  private jobs = new Map<string, JobInfo>();
  private activeByGame = new Map<string, string>();

  constructor(
    private readonly db: ChessDb,
    private readonly games: GameService,
    private readonly engine: EngineService,
    private readonly ui: UiSessionService,
    private readonly log: Logger,
  ) {}

  defaultPreset(): AnalysisPresetName {
    return this.db.getSettings().defaultPreset;
  }

  getJob(jobId: string): JobInfo {
    const job = this.jobs.get(jobId);
    if (!job) throw notFound("Job");
    return job;
  }

  cancel(jobId: string): JobInfo {
    const job = this.getJob(jobId);
    this.engine.manager.cancelJob(jobId);
    return job;
  }

  analyseGame(gameId: string, preset = this.defaultPreset()): JobInfo {
    const game = this.games.get(gameId);
    this.games.requireSupported(game);
    this.requireEngine();
    const activeId = this.activeByGame.get(gameId);
    const active = activeId ? this.jobs.get(activeId) : undefined;
    if (active && (active.state === "running" || active.state === "queued")) return active;
    if (this.engine.manager.isPaused) this.engine.manager.resume();

    const fens = this.games.positions(gameId);
    const job: JobInfo = { id: crypto.randomUUID(), kind: "FULL_GAME", gameId, state: "running", done: 0, total: fens.length };
    this.jobs.set(job.id, job);
    this.activeByGame.set(gameId, job.id);
    this.ui.broadcast({ type: "analysis.started", job: { ...job } });
    this.log.info({ component: "analysis", gameId, preset, positions: fens.length }, "Game analysis started");
    void this.runGame(job, gameId, fens, preset);
    return job;
  }

  private async runGame(job: JobInfo, gameId: string, fens: string[], preset: AnalysisPresetName): Promise<void> {
    const positions = new Map<number, EngineAnalysis>();
    const manager = this.engine.manager;
    try {
      await Promise.all(
        fens.map(async (fen, ply) => {
          // Same-root review needs the top lines of every position (V2 plan §6).
          const analysis = this.persist(
            await manager.analyse(fen, this.engine.request("FULL_GAME", preset, { jobId: job.id, multiPv: REVIEW_MULTIPV })),
          );
          positions.set(ply, analysis);
          this.db.setGamePosition(gameId, ply, analysis.id, analysis.engine);
          job.done += 1;
          this.ui.broadcast({ type: "analysis.progress", job: { ...job }, position: toPositionEvaluation(ply, analysis) });
        }),
      ).catch((err) => {
        manager.cancelJob(job.id);
        throw err;
      });

      const moves = this.db.getMoves(gameId);
      const identity = manager.identity;
      const sameRoot = !!identity?.capabilities.multipv;
      const game = this.games.get(gameId);
      const presetRequest = this.engine.request("FULL_GAME", preset, { multiPv: REVIEW_MULTIPV });
      const reviews = await reviewGame({
        gameId,
        moves,
        positions,
        engine: sameRoot ? this.reviewEngine(job.id, preset) : undefined,
        perspective: game.userColour,
        engineConfig: {
          engine: identity?.name ?? "unknown",
          version: identity?.version ?? "unknown",
          network: identity?.network,
          nodes: presetRequest.nodes,
          verificationNodes: VERIFICATION.nodes,
          multiPv: REVIEW_MULTIPV,
          threads: this.engine.threads(),
          hashMb: this.db.getSettings().hashMb,
        },
      });
      this.db.saveReviews(reviews);
      job.state = "completed";
      this.ui.broadcast({ type: "analysis.completed", job: { ...job } });
      this.log.info({ component: "analysis", gameId, reviewed: reviews.length }, "Game analysis completed");
    } catch (err) {
      if (err instanceof AbortError) job.state = "cancelled";
      else if (err instanceof EnginePausedError) job.state = "paused";
      else job.state = "failed";
      job.error = (err as Error).message;
      this.ui.broadcast({ type: "analysis.failed", job: { ...job } });
      this.log.warn({ component: "analysis", gameId, state: job.state, err: job.error }, "Game analysis stopped");
    }
  }

  /** Engine searches the Review Algorithm 2 pipeline needs, scoped to the job so Cancel stops them. */
  private reviewEngine(jobId: string, preset: AnalysisPresetName): ReviewEngine {
    const manager = this.engine.manager;
    const base = this.engine.request("CLASSIFICATION_VERIFICATION", preset, { jobId });
    return {
      restricted: async (fen, uci, deep) =>
        this.persist(
          await manager.analyse(fen, {
            ...base,
            preset: deep ? "verification" : preset,
            nodes: deep ? Math.max(base.nodes, VERIFICATION.nodes) : base.nodes,
            multiPv: 1,
            searchMoves: [uci],
          }),
        ),
      deepRoot: async (fen) =>
        this.persist(
          await manager.analyse(fen, {
            ...base,
            kind: "BRILLIANT_VERIFICATION",
            preset: "verification",
            nodes: Math.max(base.nodes, VERIFICATION.nodes),
            multiPv: VERIFICATION.multiPv,
          }),
        ),
      probe: async (fen) =>
        this.persist(await manager.analyse(fen, { ...base, preset: "custom", nodes: THREAT_SEARCH.nodes, multiPv: 1 })),
    };
  }

  /** Terminal positions are answered without the engine; store them so games can link to them. */
  private persist(analysis: EngineAnalysis): EngineAnalysis {
    if (analysis.configHash === "terminal") this.db.saveAnalysis(analysis, { terminal: true });
    return analysis;
  }

  getReview(gameId: string): GameReview {
    const game = this.games.get(gameId);
    const fens = this.games.positions(gameId);
    const reviews = this.db.getReviews(gameId);
    const stored = this.db.getGamePositions(gameId);
    const positions = fens.map((_, ply) => {
      const a = stored.get(ply);
      return a ? toPositionEvaluation(ply, a) : null;
    });
    return {
      gameId,
      algorithmVersion: reviews.length ? Math.min(...reviews.map((r) => r.algorithmVersion)) : null,
      complete: game.supported && reviews.length === fens.length - 1 && positions.every((p) => p !== null),
      reviews,
      positions,
      summary: summarise(reviews),
    };
  }

  async analysePosition(
    gameId: string,
    ply: number,
    options: { preset?: AnalysisPresetName; multipv?: number; kind?: JobKind } = {},
  ): Promise<EngineAnalysis> {
    this.games.requireSupported(this.games.get(gameId));
    const fen = this.games.positionFen(gameId, ply);
    return this.analyseFen(fen, options);
  }

  async analyseFen(fen: string, options: { preset?: AnalysisPresetName; multipv?: number; kind?: JobKind } = {}) {
    this.requireEngine();
    const preset = options.preset ?? this.defaultPreset();
    const kind = options.kind ?? (preset === "deep" ? "DEEP_ANALYSIS" : "POSITION");
    try {
      return this.persist(
        await this.engine.manager.analyse(fen, this.engine.request(kind, preset, { multiPv: options.multipv })),
      );
    } catch (err) {
      throw engineError(err);
    }
  }

  /** Validate a candidate move server-side, then analyse the resulting position (spec §48). */
  async analyseCandidate(
    gameId: string,
    ply: number,
    moveText: string,
    options: { preset?: AnalysisPresetName; kind?: JobKind } = {},
  ): Promise<{ move: VariationMove; analysis: EngineAnalysis }> {
    this.games.requireSupported(this.games.get(gameId));
    const fen = this.games.positionFen(gameId, ply);
    const parsed = parseMove(fen, moveText);
    if (!parsed.ok) throw new HttpError(422, parsed.error === "ambiguous" ? "AMBIGUOUS_MOVE" : "ILLEGAL_MOVE", parsed.message);
    const analysis = await this.analyseFen(parsed.fenAfter, { preset: options.preset, kind: options.kind ?? "CANDIDATE" });
    return { move: { san: parsed.san, uci: parsed.uci, fenAfter: parsed.fenAfter }, analysis };
  }

  private requireEngine(): void {
    const s = this.engine.status;
    if (s.state === "ready" && !this.engine.manager.isPaused) return;
    if (s.state === "checking" || s.state === "installing") return; // requests wait for the engine
    if (this.engine.manager.isPaused) return; // analyseGame resumes explicitly
    throw new HttpError(503, "ENGINE_UNAVAILABLE", s.state === "unavailable" ? s.error : "No chess engine is available.");
  }
}

export function toPositionEvaluation(ply: number, a: EngineAnalysis): PositionEvaluation {
  return { ply, fen: a.fen, evaluation: a.evaluation, wdl: a.wdl, bestLine: a.lines[0], engine: a.engine };
}

function engineError(err: unknown): Error {
  if (err instanceof HttpError) return err;
  if (err instanceof EngineUnavailableError) return new HttpError(503, "ENGINE_UNAVAILABLE", err.message);
  if (err instanceof EnginePausedError) return new HttpError(503, "ENGINE_PAUSED", err.message);
  if (err instanceof AbortError) return new HttpError(409, "CANCELLED", err.message);
  return badRequest((err as Error).message);
}
