import crypto from "node:crypto";
import fs from "node:fs";
import { sanLineToMoves, sideToMove, uciLineToMoves } from "@chessanalyser/chess-core";
import type { EngineAnalysis, EngineLine } from "@chessanalyser/shared";
import { EngineProcess } from "./process";
import { AbortError, type AnalysisOptions, type ChessEngine, type EngineIdentity, type Position } from "./types";
import { configHash, toWhiteEvaluation } from "./uci";

/** Where macOS ships Apple Chess's Sjeng engine (spec §18). */
export const SJENG_CANDIDATE_PATHS = [
  "/System/Applications/Chess.app/Contents/Resources/sjeng.ChessEngine",
  "/Applications/Chess.app/Contents/Resources/sjeng.ChessEngine",
];

export function findSjeng(): string | null {
  if (process.platform !== "darwin") return null;
  return SJENG_CANDIDATE_PATHS.find((p) => fs.existsSync(p)) ?? null;
}

interface Whisper {
  depth: number;
  /** Pawns, side-to-move relative. */
  score: number;
  pvSan: string[];
  nodes?: number;
}

/**
 * Apple's Sjeng build does not print standard xboard thinking lines. After a timed search it reports
 * `tellics whisper d<depth> <score> <SAN PV...> n: <nodes> ...` and then `move <uci>`; an immediate
 * mate shows up as a result line such as `1-0 {White Mates}`.
 */
export function parseWhisper(line: string): Whisper | null {
  const m = /^tellics whisper d(\d+)\s+(-?\d+(?:\.\d+)?)\s+(.*?)(?:\s+n:\s*(\d+).*)?$/.exec(line.trim());
  if (!m) return null;
  return {
    depth: Number(m[1]),
    score: Number(m[2]),
    pvSan: m[3]!.split(/\s+/).filter((t) => t && !/^\d+\.+$/.test(t)),
    nodes: m[4] ? Number(m[4]) : undefined,
  };
}

/** Degraded fallback engine: centipawn evaluation and a best line, no WDL, no MultiPV. */
export class SjengEngine implements ChessEngine {
  private proc: EngineProcess | null = null;
  private identity: EngineIdentity | null = null;
  private searching = false;

  constructor(
    private readonly binary: string,
    private readonly workDir: string,
  ) {}

  async identify(): Promise<EngineIdentity> {
    await this.start();
    return this.identity!;
  }

  get alive(): boolean {
    return this.proc?.alive ?? false;
  }

  searchConfig(options: AnalysisOptions): Record<string, unknown> {
    return { engine: this.identity?.name ?? "Sjeng", seconds: options.seconds ?? 2, protocol: "xboard" };
  }

  private async start(): Promise<void> {
    if (this.proc?.alive && this.identity) return;
    fs.mkdirSync(this.workDir, { recursive: true });
    // Sjeng writes learn files into its working directory; keep them out of the user's folders.
    const proc = new EngineProcess(this.binary, { cwd: this.workDir });
    this.proc = proc;
    let name = "Sjeng";
    const off = proc.onLine((l) => {
      const m = /myname="([^"]+)"/.exec(l);
      if (m) name = m[1]!;
    });
    try {
      proc.send("xboard");
      proc.send("protover 2");
      await proc.waitFor((l) => l.includes("done=1"), 15_000);
    } finally {
      off();
    }
    proc.send("easy");
    proc.send("post");
    this.identity = {
      kind: "sjeng",
      name: `Apple Chess (${name})`,
      version: /(\d+(?:\.\d+)*)/.exec(name)?.[1] ?? "unknown",
      path: this.binary,
      capabilities: { wdl: false, multipv: false },
    };
  }

  async analysePosition(position: Position, options: AnalysisOptions): Promise<EngineAnalysis> {
    await this.start();
    const proc = this.proc!;
    if (options.signal?.aborted) throw new AbortError();
    const seconds = Math.max(1, Math.round(options.seconds ?? 2));
    const stmWhite = sideToMove(position.fen) === "white";

    let whisper: Whisper | null = null;
    let mated: "white" | "black" | null = null;
    const off = proc.onLine((l) => {
      const w = parseWhisper(l);
      if (w) whisper = w;
      if (/^1-0 \{White mates\}/i.test(l)) mated = "black";
      if (/^0-1 \{Black mates\}/i.test(l)) mated = "white";
    });
    const onAbort = () => {
      if (this.searching) proc.send("?");
    };
    options.signal?.addEventListener("abort", onAbort);
    let moveUci: string;
    try {
      proc.send("new");
      proc.send("force");
      proc.send(`setboard ${position.fen}`);
      proc.send("post");
      proc.send(`st ${seconds}`);
      this.searching = true;
      proc.send("go");
      const moveLine = await proc.waitFor((l) => /^move\s+\S+/.test(l), (seconds + 20) * 1000);
      moveUci = moveLine.split(/\s+/)[1]!;
      // A mating move is followed immediately by the result line.
      await new Promise((r) => setTimeout(r, 30));
      proc.send("force");
    } finally {
      this.searching = false;
      off();
      options.signal?.removeEventListener("abort", onAbort);
    }
    if (options.signal?.aborted) throw new AbortError();

    const w = whisper as Whisper | null;
    let moves = w ? sanLineToMoves(position.fen, w.pvSan) : [];
    if (moves.length === 0 || moves[0]!.uci !== moveUci) {
      moves = uciLineToMoves(position.fen, [moveUci]);
    }
    const evaluation =
      mated === (stmWhite ? "black" : "white")
        ? { whiteCp: null, mateForWhiteIn: stmWhite ? 1 : -1 }
        : toWhiteEvaluation({ cp: Math.round((w?.score ?? 0) * 100) }, stmWhite);

    const lines: EngineLine[] =
      moves.length > 0
        ? [
            {
              id: crypto.randomUUID(),
              rank: 1,
              rootMoveUci: moves[0]!.uci,
              rootMoveSan: moves[0]!.san,
              evaluation,
              moves,
            },
          ]
        : [];
    const id = this.identity!;
    return {
      id: crypto.randomUUID(),
      engine: id.name,
      engineVersion: id.version,
      capabilities: id.capabilities,
      fen: position.fen,
      preset: options.preset,
      configHash: configHash(this.searchConfig(options)),
      nodes: w?.nodes,
      depth: w?.depth,
      evaluation,
      lines,
      createdAt: new Date().toISOString(),
    };
  }

  async stop(): Promise<void> {
    if (this.proc?.alive && this.searching) this.proc.send("?");
  }

  async dispose(): Promise<void> {
    await this.proc?.quit("quit");
    this.proc = null;
  }
}
