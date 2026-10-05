import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINE_DEFAULTS, type EngineStatus } from "@chessanalyser/shared";
import { dataPaths } from "@chessanalyser/shared/node";
import { InstallError, engineManifest, installStockfish, readManagedInstall, type InstallProgress } from "./installer";
import { MockEngine } from "./mock";
import { SjengEngine, findSjeng } from "./sjeng";
import { StockfishEngine, probeUci } from "./stockfish";
import type { ChessEngine, EngineIdentity } from "./types";

export function defaultThreads(): number {
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(ENGINE_DEFAULTS.maxThreads, Math.floor(cpus / 2)));
}

export interface EnsureEngineOptions {
  /** CHESSANALYSER_STOCKFISH_PATH or the Settings override. */
  explicitPath?: string | null;
  threads?: number;
  hashMb?: number;
  allowDownload?: boolean;
  onStatus?: (status: EngineStatus) => void;
  log?: (level: "info" | "warn", message: string) => void;
}

export interface EnsuredEngine {
  engine: ChessEngine | null;
  identity: EngineIdentity | null;
  status: EngineStatus;
}

/**
 * Find or install an engine (spec §16): explicit path → managed Stockfish → Stockfish on PATH →
 * download → macOS Apple Chess (Sjeng) fallback → unavailable.
 */
export async function ensureEngine(options: EnsureEngineOptions = {}): Promise<EnsuredEngine> {
  const log = options.log ?? (() => undefined);
  const status = (s: EngineStatus) => options.onStatus?.(s);
  const threads = options.threads ?? defaultThreads();
  const hashMb = options.hashMb ?? ENGINE_DEFAULTS.hashMb;
  const wanted = engineManifest.stockfish.version;
  status({ state: "checking" });

  if (process.env.CHESSANALYSER_ENGINE === "mock") {
    const engine = new MockEngine({ delayMs: Number(process.env.CHESSANALYSER_MOCK_DELAY_MS ?? 0) });
    const identity = await engine.identify();
    return ready(engine, identity, "mock", false, status);
  }

  const tryStockfish = async (binary: string, source: "env" | "managed" | "path" | "downloaded", requireVersion: boolean) => {
    try {
      const probe = await probeUci(binary);
      if (!/^Stockfish\b/i.test(probe.name)) {
        log("warn", `${binary} is not Stockfish (reported "${probe.name}")`);
        return null;
      }
      if (requireVersion && probe.version !== wanted) {
        log("info", `Ignoring ${probe.name} at ${binary}; ChessAnalyser uses Stockfish ${wanted}`);
        return null;
      }
      const engine = new StockfishEngine(binary, { threads, hashMb, isolateSearches: ENGINE_DEFAULTS.isolateSearches });
      const identity = await engine.identify();
      return ready(engine, identity, source, false, status);
    } catch (err) {
      log("warn", `Could not start engine at ${binary}: ${(err as Error).message}`);
      return null;
    }
  };

  // 1. Explicit path.
  const explicit = options.explicitPath ?? process.env.CHESSANALYSER_STOCKFISH_PATH;
  if (explicit) {
    const found = await tryStockfish(explicit, "env", false);
    if (found) return found;
  }

  // 2. Managed install.
  const managed = readManagedInstall(wanted);
  if (managed) {
    const found = await tryStockfish(managed.binary, "managed", true);
    if (found) return found;
  }

  // 3. Compatible Stockfish on PATH.
  for (const candidate of pathCandidates()) {
    const found = await tryStockfish(candidate, "path", true);
    if (found) return found;
  }

  // 4. Download.
  let downloadError: string | null = null;
  if (options.allowDownload !== false) {
    try {
      const record = await installStockfish((p: InstallProgress) =>
        status({ state: "installing", message: p.message, progress: p.fraction }),
      );
      log("info", `Installed Stockfish ${record.version} (archive sha256 ${record.archiveSha256})`);
      const found = await tryStockfish(record.binary, "downloaded", true);
      if (found) return found;
      downloadError = "The installed engine could not be started.";
    } catch (err) {
      downloadError = err instanceof InstallError || err instanceof Error ? err.message : String(err);
      log("warn", `Stockfish installation failed: ${downloadError}`);
    }
  }

  // 5. Apple Chess fallback.
  const sjeng = findSjeng();
  if (sjeng) {
    try {
      const engine = new SjengEngine(sjeng, dataPaths.sjengWorkDir());
      const identity = await engine.identify();
      return ready(engine, identity, "sjeng", true, status);
    } catch (err) {
      log("warn", `Apple Chess engine could not be started: ${(err as Error).message}`);
    }
  }

  // 6. Unavailable.
  const s: EngineStatus = {
    state: "unavailable",
    error: downloadError ?? "No chess engine is available.",
    downloadFailed: downloadError !== null,
    detectedFallback: false,
  };
  status(s);
  return { engine: null, identity: null, status: s };
}

function ready(
  engine: ChessEngine,
  identity: EngineIdentity,
  source: Extract<EngineStatus, { state: "ready" }>["source"],
  fallback: boolean,
  status: (s: EngineStatus) => void,
): EnsuredEngine {
  const s: EngineStatus = {
    state: "ready",
    kind: identity.kind,
    name: identity.name,
    version: identity.version,
    path: identity.path,
    source,
    fallback,
  };
  status(s);
  return { engine, identity, status: s };
}

function pathCandidates(): string[] {
  const names = process.platform === "win32" ? ["stockfish.exe"] : ["stockfish"];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) out.push(full);
      } catch {
        // not here
      }
    }
  }
  return [...new Set(out)];
}
