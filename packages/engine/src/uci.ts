// Pure UCI output parsing and White-POV normalisation. Raw engine output never leaves this package.
import crypto from "node:crypto";
import { sideToMove, uciLineToMoves } from "@chessanalyser/chess-core";
import type { EngineAnalysis, EngineCapabilities, EngineLine, NormalisedEvaluation, Wdl } from "@chessanalyser/shared";

export interface UciInfo {
  multipv: number;
  depth?: number;
  nodes?: number;
  /** Side-to-move relative. */
  cp?: number;
  /** Side-to-move relative: positive means the side to move mates. */
  mate?: number;
  bound?: "lower" | "upper";
  /** Side-to-move relative, per mille. */
  wdl?: [number, number, number];
  pv: string[];
}

export function parseInfoLine(line: string): UciInfo | null {
  if (!line.startsWith("info ") || line.startsWith("info string")) return null;
  const t = line.split(/\s+/);
  const info: UciInfo = { multipv: 1, pv: [] };
  let sawScore = false;
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case "depth":
        info.depth = Number(t[++i]);
        break;
      case "nodes":
        info.nodes = Number(t[++i]);
        break;
      case "multipv":
        info.multipv = Number(t[++i]);
        break;
      case "score": {
        const kind = t[++i];
        const value = Number(t[++i]);
        if (kind === "cp") info.cp = value;
        else if (kind === "mate") info.mate = value;
        sawScore = true;
        if (t[i + 1] === "lowerbound" || t[i + 1] === "upperbound") {
          info.bound = t[++i] === "lowerbound" ? "lower" : "upper";
        }
        break;
      }
      case "wdl":
        info.wdl = [Number(t[++i]), Number(t[++i]), Number(t[++i])];
        break;
      case "pv":
        info.pv = t.slice(i + 1);
        i = t.length;
        break;
      default:
        break;
    }
  }
  return sawScore ? info : null;
}

/** NNUE network announced in `uci` option defaults or `info string` lines. */
export function parseNetwork(line: string): string | null {
  const m = /(nn-[0-9a-f]+\.nnue)/.exec(line);
  return m ? m[1]! : null;
}

export function toWhiteEvaluation(info: Pick<UciInfo, "cp" | "mate">, stmWhite: boolean): NormalisedEvaluation {
  const sign = stmWhite ? 1 : -1;
  if (info.mate !== undefined && info.mate !== 0) return { whiteCp: null, mateForWhiteIn: sign * info.mate };
  return { whiteCp: sign * (info.cp ?? 0), mateForWhiteIn: null };
}

export function toWhiteWdl(wdl: [number, number, number], stmWhite: boolean): Wdl {
  const total = wdl[0] + wdl[1] + wdl[2] || 1000;
  const [w, d, l] = wdl.map((x) => x / total) as [number, number, number];
  return stmWhite ? { whiteWin: w, draw: d, blackWin: l } : { whiteWin: l, draw: d, blackWin: w };
}

/**
 * Keep the most informative report per MultiPV slot: the deepest exact (non-bound) score with a PV,
 * falling back to the latest bound score.
 */
export function collectFinalInfos(infos: UciInfo[]): UciInfo[] {
  const bySlot = new Map<number, UciInfo>();
  for (const info of infos) {
    if (info.pv.length === 0) continue;
    const prev = bySlot.get(info.multipv);
    if (!prev || !info.bound || prev.bound) bySlot.set(info.multipv, info);
  }
  return [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

export function buildAnalysis(args: {
  fen: string;
  infos: UciInfo[];
  engine: string;
  engineVersion: string;
  capabilities: EngineCapabilities;
  preset: EngineAnalysis["preset"];
  configHash: string;
}): EngineAnalysis {
  const stmWhite = sideToMove(args.fen) === "white";
  const finals = collectFinalInfos(args.infos);
  const lines: EngineLine[] = [];
  for (const info of finals) {
    const moves = uciLineToMoves(args.fen, info.pv);
    if (moves.length === 0) continue;
    // A node-limited search can stop mid-iteration, leaving a stale report in a later MultiPV slot
    // that repeats a root move already listed; keep each root move once (the higher-ranked report).
    if (lines.some((l) => l.rootMoveUci === moves[0]!.uci)) continue;
    lines.push({
      id: crypto.randomUUID(),
      rank: lines.length + 1,
      rootMoveUci: moves[0]!.uci,
      rootMoveSan: moves[0]!.san,
      evaluation: toWhiteEvaluation(info, stmWhite),
      wdl: info.wdl ? toWhiteWdl(info.wdl, stmWhite) : undefined,
      moves,
    });
  }
  const top = finals[0];
  return {
    id: crypto.randomUUID(),
    engine: args.engine,
    engineVersion: args.engineVersion,
    capabilities: args.capabilities,
    fen: args.fen,
    preset: args.preset,
    configHash: args.configHash,
    nodes: top?.nodes,
    depth: top?.depth,
    evaluation: top ? toWhiteEvaluation(top, stmWhite) : { whiteCp: 0, mateForWhiteIn: null },
    wdl: top?.wdl ? toWhiteWdl(top.wdl, stmWhite) : undefined,
    lines,
    createdAt: new Date().toISOString(),
  };
}

/** Canonical (key-sorted) JSON hash of a search configuration. */
export function configHash(config: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(canonicalJson(config)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
