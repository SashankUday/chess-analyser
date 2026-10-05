import crypto from "node:crypto";
import fs from "node:fs";
import type { EngineAnalysis } from "@chessanalyser/shared";
import { ENGINE_DEFAULTS } from "@chessanalyser/shared";
import { EngineProcess } from "./process";
import { AbortError, type AnalysisOptions, type ChessEngine, type EngineIdentity, type Position } from "./types";
import { buildAnalysis, configHash, parseInfoLine, parseNetwork, type UciInfo } from "./uci";

export interface StockfishOptions {
  threads: number;
  hashMb: number;
  /** Clear the transposition table before every independent search (reproducible cache entries). */
  isolateSearches?: boolean;
}

/** Read `id name` and the default NNUE network from a UCI engine without keeping it running. */
export async function probeUci(binary: string): Promise<{ name: string; version: string; network: string | null }> {
  const proc = new EngineProcess(binary);
  const lines: string[] = [];
  const off = proc.onLine((l) => lines.push(l));
  try {
    proc.send("uci");
    await proc.waitFor((l) => l === "uciok", 15_000);
  } finally {
    off();
    await proc.quit("quit");
  }
  const idName = lines.find((l) => l.startsWith("id name "))?.slice("id name ".length).trim() ?? "";
  if (!idName) throw new Error("The engine did not identify itself over UCI.");
  const network = lines.map(parseNetwork).find((n) => n !== null) ?? null;
  const version = /Stockfish\s+(\S+)/i.exec(idName)?.[1] ?? idName;
  return { name: idName, version, network };
}

export function sha256File(file: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export class StockfishEngine implements ChessEngine {
  private proc: EngineProcess | null = null;
  private identity: EngineIdentity | null = null;
  private currentMultiPv = 1;
  private searching = false;

  constructor(
    private readonly binary: string,
    private readonly options: StockfishOptions,
  ) {}

  async identify(): Promise<EngineIdentity> {
    await this.start();
    return this.identity!;
  }

  get alive(): boolean {
    return this.proc?.alive ?? false;
  }

  searchConfig(options: AnalysisOptions): Record<string, unknown> {
    const id = this.identity;
    return {
      engine: id?.name ?? "Stockfish",
      binarySha256: id?.binarySha256,
      network: id?.network,
      nodes: options.nodes,
      multiPv: options.multiPv,
      threads: this.options.threads,
      hashMb: this.options.hashMb,
      searchMoves: options.searchMoves?.length ? [...options.searchMoves].sort() : undefined,
      uciOptions: { UCI_ShowWDL: true },
      isolateSearches: this.options.isolateSearches ?? ENGINE_DEFAULTS.isolateSearches,
    };
  }

  private async start(): Promise<void> {
    if (this.proc?.alive && this.identity) return;
    const proc = new EngineProcess(this.binary);
    this.proc = proc;
    const lines: string[] = [];
    const off = proc.onLine((l) => lines.push(l));
    try {
      proc.send("uci");
      await proc.waitFor((l) => l === "uciok", 15_000);
    } finally {
      off();
    }
    const idName = lines.find((l) => l.startsWith("id name "))?.slice(8).trim() ?? "Stockfish";
    proc.send(`setoption name Threads value ${this.options.threads}`);
    proc.send(`setoption name Hash value ${this.options.hashMb}`);
    proc.send("setoption name UCI_ShowWDL value true");
    proc.send("setoption name MultiPV value 1");
    this.currentMultiPv = 1;
    proc.send("isready");
    await proc.waitFor((l) => l === "readyok", 30_000);
    this.identity = {
      kind: "stockfish",
      name: idName,
      version: /Stockfish\s+(\S+)/i.exec(idName)?.[1] ?? idName,
      path: this.binary,
      capabilities: { wdl: true, multipv: true },
      network: lines.map(parseNetwork).find((n) => n !== null) ?? undefined,
      binarySha256: this.identity?.binarySha256 ?? sha256File(this.binary),
    };
  }

  async analysePosition(position: Position, options: AnalysisOptions): Promise<EngineAnalysis> {
    await this.start();
    const proc = this.proc!;
    if (options.signal?.aborted) throw new AbortError();

    if (this.options.isolateSearches ?? ENGINE_DEFAULTS.isolateSearches) {
      proc.send("ucinewgame");
    }
    if (options.multiPv !== this.currentMultiPv) {
      proc.send(`setoption name MultiPV value ${options.multiPv}`);
      this.currentMultiPv = options.multiPv;
    }
    proc.send("isready");
    await proc.waitFor((l) => l === "readyok", 30_000);

    const infos: UciInfo[] = [];
    const off = proc.onLine((l) => {
      const info = parseInfoLine(l);
      if (info) infos.push(info);
    });
    const onAbort = () => {
      if (this.searching) proc.send("stop");
    };
    options.signal?.addEventListener("abort", onAbort);
    try {
      proc.send(`position fen ${position.fen}`);
      const searchMoves = options.searchMoves?.length ? ` searchmoves ${options.searchMoves.join(" ")}` : "";
      this.searching = true;
      proc.send(`go nodes ${options.nodes}${searchMoves}`);
      await proc.waitFor((l) => l.startsWith("bestmove"), 0);
    } finally {
      this.searching = false;
      off();
      options.signal?.removeEventListener("abort", onAbort);
    }
    if (options.signal?.aborted) throw new AbortError();

    const id = this.identity!;
    return buildAnalysis({
      fen: position.fen,
      infos,
      engine: "Stockfish",
      engineVersion: id.version,
      capabilities: id.capabilities,
      preset: options.preset,
      configHash: configHash(this.searchConfig(options)),
    });
  }

  async stop(): Promise<void> {
    if (this.proc?.alive && this.searching) {
      this.proc.send("stop");
      await this.proc.waitFor((l) => l.startsWith("bestmove"), 5_000).catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    await this.proc?.quit("quit");
    this.proc = null;
  }

  /** Test hook: simulate a crash. */
  kill(): void {
    this.proc?.kill();
  }
}
