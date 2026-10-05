import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineAnalysis } from "@chessanalyser/shared";
import {
  AbortError,
  EngineCrashedError,
  EngineManager,
  EnginePausedError,
  InstallError,
  MockEngine,
  buildAnalysis,
  collectFinalInfos,
  configHash,
  installStockfish,
  parseInfoLine,
  parseWhisper,
  toWhiteWdl,
  type AnalysisCache,
  type AnalysisOptions,
  type ChessEngine,
  type EngineIdentity,
} from "../src";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

describe("UCI parsing", () => {
  it("parses score, WDL, multipv and PV", () => {
    const info = parseInfoLine(
      "info depth 18 seldepth 24 multipv 2 score cp -15 wdl 10 957 33 nodes 41000 nps 1 hashfull 0 tbhits 0 time 1 pv c7c5 g1f3",
    );
    expect(info).toMatchObject({ depth: 18, multipv: 2, cp: -15, wdl: [10, 957, 33], nodes: 41000, pv: ["c7c5", "g1f3"] });
    expect(parseInfoLine("info string NNUE evaluation using nn-1a298aa575a0.nnue")).toBeNull();
    expect(parseInfoLine("info depth 3 score mate -2 upperbound pv e7e5")).toMatchObject({ mate: -2, bound: "upper" });
  });

  it("normalises side-to-move scores to White's point of view", () => {
    const a = buildAnalysis({
      fen: AFTER_E4,
      infos: [parseInfoLine("info depth 20 multipv 1 score cp -30 wdl 20 900 80 nodes 1000 pv e7e5")!],
      engine: "Stockfish",
      engineVersion: "19",
      capabilities: { wdl: true, multipv: true },
      preset: "standard",
      configHash: "x",
    });
    expect(a.evaluation).toEqual({ whiteCp: 30, mateForWhiteIn: null });
    expect(a.wdl).toEqual({ whiteWin: 0.08, draw: 0.9, blackWin: 0.02 });
    expect(a.lines[0]).toMatchObject({ rootMoveSan: "e5", rank: 1 });
    expect(toWhiteWdl([1000, 0, 0], true)).toEqual({ whiteWin: 1, draw: 0, blackWin: 0 });
  });

  it("represents mate for the side to move as White-relative mate", () => {
    const a = buildAnalysis({
      fen: AFTER_E4,
      infos: [parseInfoLine("info depth 5 multipv 1 score mate 3 wdl 1000 0 0 pv e7e5")!],
      engine: "Stockfish",
      engineVersion: "19",
      capabilities: { wdl: true, multipv: true },
      preset: "standard",
      configHash: "x",
    });
    expect(a.evaluation.mateForWhiteIn).toBe(-3);
  });

  it("prefers exact scores over later bound scores per MultiPV slot", () => {
    const infos = [
      parseInfoLine("info depth 10 multipv 1 score cp 20 pv e2e4")!,
      parseInfoLine("info depth 11 multipv 1 score cp 50 lowerbound pv d2d4")!,
    ];
    expect(collectFinalInfos(infos)[0]!.pv).toEqual(["e2e4"]);
  });

  it("parses Apple Sjeng whisper lines", () => {
    expect(
      parseWhisper("tellics whisper d10 -0.18 e6 Nf3 Be7 Be2 n: 6586368 qp: 30% fh: 86% time: 3.01 nps: 2189863"),
    ).toEqual({ depth: 10, score: -0.18, pvSan: ["e6", "Nf3", "Be7", "Be2"], nodes: 6586368 });
  });
});

describe("cache key", () => {
  const base = { engine: "Stockfish 19", network: "nn-a.nnue", binarySha256: "b", nodes: 200000, multiPv: 1, threads: 4, hashMb: 256 };
  it("changes with every search-affecting setting", () => {
    const h = configHash(base);
    for (const change of [
      { threads: 2 },
      { hashMb: 128 },
      { nodes: 50000 },
      { multiPv: 3 },
      { network: "nn-b.nnue" },
      { binarySha256: "c" },
      { engine: "Stockfish 18" },
      { searchMoves: ["e2e4"] },
    ]) {
      expect(configHash({ ...base, ...change })).not.toBe(h);
    }
  });
  it("is independent of key order", () => {
    expect(configHash({ a: 1, b: 2 })).toBe(configHash({ b: 2, a: 1 }));
  });
});

class FakeEngine implements ChessEngine {
  calls: string[] = [];
  crashTimes = 0;
  constructor(private readonly hasWdl = true) {}
  async identify(): Promise<EngineIdentity> {
    return { kind: "stockfish", name: "Fake", version: "1", path: "-", capabilities: { wdl: this.hasWdl, multipv: true } };
  }
  searchConfig(o: AnalysisOptions) {
    return { nodes: o.nodes, multiPv: o.multiPv };
  }
  async analysePosition(p: { fen: string }, o: AnalysisOptions): Promise<EngineAnalysis> {
    this.calls.push(p.fen);
    await new Promise((r) => setTimeout(r, 5));
    if (o.signal?.aborted) throw new AbortError();
    if (this.crashTimes > 0) {
      this.crashTimes--;
      throw new EngineCrashedError();
    }
    return new MockEngine().analysePosition(p, o);
  }
  async stop() {}
  async dispose() {}
}

function memoryCache(): AnalysisCache & { map: Map<string, EngineAnalysis> } {
  const map = new Map<string, EngineAnalysis>();
  return { map, get: (f, h) => map.get(`${f}|${h}`) ?? null, put: (a) => void map.set(`${a.fen}|${a.configHash}`, a) };
}

async function managerWith(engine: FakeEngine, cache: AnalysisCache | null = null) {
  const m = new EngineManager(cache);
  await m.setEngine({
    engine,
    identity: await engine.identify(),
    status: { state: "ready", kind: "stockfish", name: "Fake", version: "1", path: "-", source: "path", fallback: false },
  });
  return m;
}

const req = (kind: "FULL_GAME" | "POSITION", jobId?: string) =>
  ({ kind, preset: "standard", nodes: 10, multiPv: 1, jobId }) as const;

describe("EngineManager", () => {
  it("runs interactive requests ahead of queued full-game positions", async () => {
    const engine = new FakeEngine();
    const m = await managerWith(engine);
    const fens = [START, AFTER_E4, "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"];
    const bulk = fens.map((f) => m.analyse(f, req("FULL_GAME", "job")));
    const interactive = m.analyse("4k3/8/8/8/8/8/8/R3K3 w Q - 0 1", req("POSITION"));
    await Promise.all([...bulk, interactive]);
    // The first bulk position was already running; the interactive one goes next.
    expect(engine.calls[1]).toBe("4k3/8/8/8/8/8/8/R3K3 w Q - 0 1");
  });

  it("serves repeated positions from cache and dedupes in-flight requests", async () => {
    const engine = new FakeEngine();
    const cache = memoryCache();
    const m = await managerWith(engine, cache);
    await Promise.all([m.analyse(START, req("POSITION")), m.analyse(START, req("POSITION"))]);
    await m.analyse(START, req("POSITION"));
    expect(engine.calls).toEqual([START]);
  });

  it("treats a WDL-less Stockfish cache row as a miss", async () => {
    const engine = new FakeEngine();
    const cache = memoryCache();
    const m = await managerWith(engine, cache);
    const first = await m.analyse(START, req("POSITION"));
    cache.map.set(`${START}|${first.configHash}`, { ...first, wdl: undefined });
    await m.analyse(START, req("POSITION"));
    expect(engine.calls).toHaveLength(2);
  });

  it("cancels queued tasks for a job", async () => {
    const engine = new FakeEngine();
    const m = await managerWith(engine);
    const a = m.analyse(START, req("FULL_GAME", "j1"));
    const b = m.analyse(AFTER_E4, req("FULL_GAME", "j1"));
    m.cancelJob("j1");
    await expect(b).rejects.toBeInstanceOf(AbortError);
    await a.catch(() => undefined);
  });

  it("restarts once after a crash, then pauses if it crashes again", async () => {
    const engine = new FakeEngine();
    const m = await managerWith(engine);
    engine.crashTimes = 1;
    await expect(m.analyse(START, req("POSITION"))).resolves.toBeTruthy();
    engine.crashTimes = 2;
    await expect(m.analyse(AFTER_E4, req("POSITION"))).rejects.toBeInstanceOf(EnginePausedError);
    expect(m.isPaused).toBe(true);
    expect(m.status.state).toBe("unavailable");
    m.resume();
    expect(m.status.state).toBe("ready");
  });

  it("answers finished positions without the engine", async () => {
    const engine = new FakeEngine();
    const m = await managerWith(engine);
    const mate = await m.analyse("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3", req("POSITION"));
    expect(mate.evaluation.terminal).toEqual({ kind: "checkmate", winner: "black" });
    expect(mate.wdl).toEqual({ whiteWin: 0, draw: 0, blackWin: 1 });
    expect(engine.calls).toHaveLength(0);
  });
});

describe("installer", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-install-"));
    process.env.CHESSANALYSER_DATA_DIR = dir;
  });
  afterAll(() => {
    delete process.env.CHESSANALYSER_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a download whose SHA-256 does not match and leaves nothing behind", async () => {
    const fakeFetch = (async () => new Response("not stockfish", { status: 200 })) as typeof fetch;
    const err = await installStockfish(() => undefined, {
      fetchImpl: fakeFetch,
      entry: { url: "https://example.invalid/sf.tar.gz", sha256: "00".repeat(32), archive: "tar.gz", binary: "x" },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect(err.kind).toBe("checksum");
    expect(fs.readdirSync(path.join(dir, "engines"))).toEqual([]);
  });

  it("reports download failures", async () => {
    const fakeFetch = (async () => new Response("", { status: 503 })) as typeof fetch;
    const err = await installStockfish(() => undefined, {
      fetchImpl: fakeFetch,
      entry: { url: "https://example.invalid/sf.tar.gz", sha256: "00", archive: "tar.gz", binary: "x" },
    }).catch((e) => e);
    expect(err.kind).toBe("download");
  });
});
