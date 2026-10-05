import fs from "node:fs";
import type { ChessDb } from "@chessanalyser/database";
import { EngineManager, defaultThreads, ensureEngine, managedInstallDir, type AnalysisCache } from "@chessanalyser/engine";
import { ANALYSIS_PRESETS, SJENG_SECONDS_PER_PRESET, type AnalysisPresetName, type EngineStatus, type JobKind } from "@chessanalyser/shared";
import type { Logger } from "../logger";

/** Engine lifecycle: find/install on startup, reconfigure on settings change, reinstall on request. */
export class EngineService {
  readonly manager: EngineManager;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly db: ChessDb,
    private readonly log: Logger,
  ) {
    const cache: AnalysisCache = {
      get: (fen, hash) => db.findAnalysis(fen, hash),
      put: (analysis, config) => void db.saveAnalysis(analysis, config),
    };
    this.manager = new EngineManager(cache);
  }

  get status(): EngineStatus {
    return this.manager.status;
  }

  threads(): number {
    const t = this.db.getSettings().threads;
    return t === "auto" ? defaultThreads() : t;
  }

  /** Start engine discovery in the background; the server is usable (games, review) meanwhile. */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    const settings = this.db.getSettings();
    this.starting = ensureEngine({
      explicitPath: process.env.CHESSANALYSER_STOCKFISH_PATH ?? settings.stockfishPath,
      threads: this.threads(),
      hashMb: settings.hashMb,
      onStatus: (s) => {
        this.manager.setStatus(s);
        this.logInstallProgress(s);
      },
      log: (level, message) => this.log[level]({ component: "engine" }, message),
    })
      .then(async (ensured) => {
        await this.manager.setEngine(ensured);
        if (ensured.status.state === "ready") {
          this.log.info(
            { component: "engine", engine: ensured.identity?.name, network: ensured.identity?.network, source: ensured.status.source },
            ensured.status.fallback ? "Using Apple Chess fallback engine" : "Engine ready",
          );
        } else {
          this.log.warn({ component: "engine" }, `Engine unavailable: ${ensured.status.state === "unavailable" ? ensured.status.error : ""}`);
        }
      })
      .catch((err: Error) => {
        this.log.error({ component: "engine", err: err.message }, "Engine startup failed");
        this.manager.setStatus({ state: "unavailable", error: err.message });
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private lastInstallLog = "";

  /** Console narration of a first-run install (spec §3), without logging every percent. */
  private logInstallProgress(s: EngineStatus): void {
    if (s.state === "checking" && this.lastInstallLog === "") {
      this.log.info({ component: "engine" }, "Checking engine...");
      this.lastInstallLog = "checking";
    }
    if (s.state !== "installing") return;
    const bucket = s.progress !== undefined ? Math.floor(s.progress * 4) : -1;
    const key = `${s.message}:${bucket}`;
    if (key === this.lastInstallLog) return;
    this.lastInstallLog = key;
    const pct = s.progress !== undefined && s.progress > 0 ? ` ${Math.round(s.progress * 100)}%` : "";
    this.log.info({ component: "engine" }, `${s.message}${pct}`);
  }

  /** Re-run discovery (e.g. Retry after a failed download, or new Threads/Hash settings). */
  async restart(): Promise<void> {
    await this.starting;
    return this.start();
  }

  async reinstall(): Promise<void> {
    await this.starting;
    fs.rmSync(managedInstallDir(), { recursive: true, force: true });
    return this.start();
  }

  /** Engine request parameters for a preset, adapted to the active engine. */
  request(kind: JobKind, preset: AnalysisPresetName, overrides: { multiPv?: number; nodes?: number; searchMoves?: string[]; jobId?: string } = {}) {
    const p = ANALYSIS_PRESETS[preset];
    return {
      kind,
      preset,
      nodes: overrides.nodes ?? p.nodes,
      multiPv: overrides.multiPv ?? p.multiPv,
      seconds: SJENG_SECONDS_PER_PRESET[preset],
      searchMoves: overrides.searchMoves,
      jobId: overrides.jobId,
    } as const;
  }

  dispose(): Promise<void> {
    return this.manager.dispose();
  }
}
