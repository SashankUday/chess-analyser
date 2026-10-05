import crypto from "node:crypto";
import { legalMoves, material, mateInOne, sideToMove, staticExchange, uciLineToMoves } from "@chessanalyser/chess-core";
import type { EngineAnalysis, EngineLine, NormalisedEvaluation, Wdl } from "@chessanalyser/shared";
import type { AnalysisOptions, ChessEngine, EngineIdentity, Position } from "./types";
import { configHash } from "./uci";

/**
 * Deterministic stand-in engine for automated tests and `CHESSANALYSER_ENGINE=mock` browser tests.
 * It is labelled "Mock engine" everywhere and is never selected automatically.
 */
export class MockEngine implements ChessEngine {
  private delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    this.delayMs = options.delayMs ?? 0;
  }

  async identify(): Promise<EngineIdentity> {
    return {
      kind: "mock",
      name: "Mock engine",
      version: "1",
      path: "(built-in)",
      capabilities: { wdl: true, multipv: true },
    };
  }

  searchConfig(options: AnalysisOptions): Record<string, unknown> {
    return { engine: "mock", nodes: options.nodes, multiPv: options.multiPv, searchMoves: options.searchMoves };
  }

  async analysePosition(position: Position, options: AnalysisOptions): Promise<EngineAnalysis> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const fen = position.fen;
    const stmWhite = sideToMove(fen) === "white";
    const sign = stmWhite ? 1 : -1;
    const base = material(fen).balance * 100;

    const mateMove = mateInOne(fen)?.lan;
    const scored = legalMoves(fen)
      .filter((m) => !options.searchMoves?.length || options.searchMoves.includes(m.lan))
      .map((m) => {
        const mate = mateMove === m.lan;
        const gain = staticExchange(fen, m);
        return { m, mate, score: mate ? 1e6 : gain * 100 };
      })
      .sort((a, b) => b.score - a.score || a.m.lan.localeCompare(b.m.lan));

    const lines: EngineLine[] = scored.slice(0, options.multiPv).map((s, i) => {
      const evaluation: NormalisedEvaluation = s.mate
        ? { whiteCp: null, mateForWhiteIn: sign }
        : { whiteCp: base + sign * s.score, mateForWhiteIn: null };
      return {
        id: crypto.randomUUID(),
        rank: i + 1,
        rootMoveUci: s.m.lan,
        rootMoveSan: s.m.san,
        evaluation,
        wdl: mockWdl(evaluation),
        moves: uciLineToMoves(fen, [s.m.lan, ...greedyReply(s.m.after)]),
      };
    });
    const top = lines[0];
    const evaluation = top?.evaluation ?? { whiteCp: base, mateForWhiteIn: null };
    return {
      id: crypto.randomUUID(),
      engine: "Mock engine",
      engineVersion: "1",
      capabilities: { wdl: true, multipv: true },
      fen,
      preset: options.preset,
      configHash: configHash(this.searchConfig(options)),
      nodes: options.nodes,
      depth: 1,
      evaluation,
      wdl: mockWdl(evaluation),
      lines,
      createdAt: new Date().toISOString(),
    };
  }

  async stop(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function mockWdl(e: NormalisedEvaluation): Wdl {
  if (e.mateForWhiteIn !== null) return e.mateForWhiteIn > 0 ? { whiteWin: 1, draw: 0, blackWin: 0 } : { whiteWin: 0, draw: 0, blackWin: 1 };
  const p = 1 / (1 + Math.exp(-(e.whiteCp ?? 0) / 250));
  const draw = Math.max(0, 0.6 - Math.abs(p - 0.5) * 1.2);
  const rest = 1 - draw;
  return { whiteWin: rest * p, draw, blackWin: rest * (1 - p) };
}

/** A deterministic short continuation: the opponent's best capture by static exchange, if any. */
function greedyReply(fen: string): string[] {
  const capture = legalMoves(fen)
    .filter((m) => m.captured)
    .map((m) => ({ m, gain: staticExchange(fen, m) }))
    .sort((a, b) => b.gain - a.gain || a.m.lan.localeCompare(b.m.lan))[0];
  return capture && capture.gain > 0 ? [capture.m.lan] : [];
}
