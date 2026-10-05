// Internal calibration report (V2 plan §45). Analyses a varied set of imported games with Review
// Algorithm 2 and real Stockfish, then summarises how the labels are distributed so the central
// constants in packages/shared/src/constants.ts can be tuned against real games — never per example.
//
//   npm run calibrate -- --games 40 [--preset standard] [--out .data/calibration-report.md]
//
// Uses the normal data folder (or CHESSANALYSER_DATA_DIR). Stop `npm run dev` first.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ChessDb } from "@chessanalyser/database";
import {
  CLASSIFICATION_LABELS,
  CLASSIFICATION_ORDER,
  REVIEW_ALGORITHM_VERSION,
  formatEvaluation,
  moveNumberLabel,
  type AnalysisPresetName,
  type GameSummary,
  type MoveClassification,
  type MoveReview,
} from "@chessanalyser/shared";
import { dataPaths } from "@chessanalyser/shared/node";
import { createContext } from "../apps/server/src/context";
import { createLogger } from "../apps/server/src/logger";

const { values: args } = parseArgs({
  options: {
    games: { type: "string", default: "40" },
    preset: { type: "string", default: "standard" },
    out: { type: "string" },
    reanalyse: { type: "boolean", default: false },
  },
});
const wanted = Number(args.games);
const preset = args.preset as AnalysisPresetName;
const outFile = path.resolve(args.out ?? path.join(dataPaths.root(), "calibration-report.md"));

process.env.CHESSANALYSER_LOG_FILE = "0";
process.env.CHESSANALYSER_LOG_LEVEL ??= "warn";
const log = createLogger();
const db = new ChessDb(dataPaths.database());
const ctx = createContext({
  db,
  log,
  security: { uiToken: "-", mcpToken: "-", allowedOrigins: new Set(), allowedHosts: new Set() },
});

console.log(`ChessAnalyser calibration — data: ${dataPaths.root()}`);
await ctx.engine.start();
const status = ctx.engine.status;
if (status.state !== "ready" || status.kind !== "stockfish") {
  console.error(`Stockfish is required for calibration (engine: ${JSON.stringify(status)}).`);
  process.exit(1);
}
console.log(`Engine: ${status.name} · preset ${preset} · Review Algorithm ${REVIEW_ALGORITHM_VERSION}\n`);

// ---- Pick a varied, deterministic sample: round-robin over time classes, newest first ----
const all = db.listGames({ filter: "all", limit: 5000, offset: 0 }).filter((g) => g.supported && g.plyCount >= 20);
const byClass = new Map<string, GameSummary[]>();
for (const g of all) byClass.set(g.timeClass, [...(byClass.get(g.timeClass) ?? []), g]);
const sample: GameSummary[] = [];
for (let i = 0; sample.length < wanted && [...byClass.values()].some((l) => l.length > i); i++) {
  for (const list of byClass.values()) if (list[i] && sample.length < wanted) sample.push(list[i]!);
}
if (sample.length === 0) {
  console.error("No standard games with 20+ plies found. Import some games first.");
  process.exit(1);
}

// ---- Analyse ----
const started = Date.now();
for (const [i, g] of sample.entries()) {
  const existing = db.getReviews(g.id);
  if (!args.reanalyse && existing.length && existing.every((r) => r.algorithmVersion === REVIEW_ALGORITHM_VERSION)) {
    console.log(`[${i + 1}/${sample.length}] ${g.white.username}–${g.black.username} (cached)`);
    continue;
  }
  const job = ctx.analysis.analyseGame(g.id, preset);
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const j = ctx.analysis.getJob(job.id);
    if (j.state === "completed") break;
    if (j.state !== "running" && j.state !== "queued") throw new Error(`Analysis ${j.state}: ${j.error}`);
  }
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`[${i + 1}/${sample.length}] ${g.white.username}–${g.black.username} ${g.timeClass} ${g.plyCount} plies · ${mins} min`);
}

// ---- Aggregate ----
interface Row {
  review: MoveReview;
  game: GameSummary;
}
const rows: Row[] = [];
for (const g of sample) for (const r of db.getReviews(g.id)) if (r.v2 && !r.reduced) rows.push({ review: r, game: g });

const stats = new Map<MoveClassification, { n: number; cp: number; win: number; ranks: Record<string, number> }>();
for (const c of CLASSIFICATION_ORDER) stats.set(c, { n: 0, cp: 0, win: 0, ranks: { "1": 0, "2": 0, "3": 0, "–": 0 } });
let misses = 0;
let verified = 0;
let overridden = 0;
const missKinds: Record<string, number> = {};
for (const { review: r } of rows) {
  const s = stats.get(r.classification)!;
  const m = r.v2!.metrics;
  s.n += 1;
  s.cp += m.cpLoss;
  s.win += m.winPercentLoss;
  s.ranks[m.playedRank ? String(m.playedRank) : "–"] = (s.ranks[m.playedRank ? String(m.playedRank) : "–"] ?? 0) + 1;
  const miss = r.badges.filter((b) => b.startsWith("missed_"));
  if (miss.length) misses += 1;
  for (const b of miss) missKinds[b] = (missKinds[b] ?? 0) + 1;
  if (r.verified) verified += 1;
  if (r.v2!.diagnostics.overrides.length) overridden += 1;
}

const total = rows.length;
const pct = (n: number) => `${((100 * n) / Math.max(1, total)).toFixed(1)}%`;
const lines: string[] = [];
lines.push(`# ChessAnalyser calibration report`, "");
lines.push(`- Generated: ${new Date().toISOString()}`);
lines.push(`- Engine: ${status.name} · preset **${preset}** · Review Algorithm ${REVIEW_ALGORITHM_VERSION}`);
lines.push(`- Games: ${sample.length} (${[...new Set(sample.map((g) => g.timeClass))].join(", ")}) · moves reviewed: ${total}`);
lines.push(`- Verified by deeper search: ${verified} (${pct(verified)}) · raised by an override: ${overridden} (${pct(overridden)})`, "");
lines.push(`## Distribution`, "");
lines.push(`| Classification | Moves | Share | Avg cp loss | Avg Win% loss | Rank 1 / 2 / 3 / outside |`);
lines.push(`| --- | ---: | ---: | ---: | ---: | --- |`);
for (const c of CLASSIFICATION_ORDER) {
  const s = stats.get(c)!;
  if (!s.n) continue;
  lines.push(
    `| ${CLASSIFICATION_LABELS[c]} | ${s.n} | ${pct(s.n)} | ${(s.cp / s.n).toFixed(0)} | ${(s.win / s.n).toFixed(2)} | ${s.ranks["1"]} / ${s.ranks["2"]} / ${s.ranks["3"]} / ${s.ranks["–"]} |`,
  );
}
lines.push(`| Miss (badge) | ${misses} | ${pct(misses)} | | | ${Object.entries(missKinds).map(([k, v]) => `${k} ${v}`).join(", ")} |`, "");

lines.push(`## Representative moves`, "", "Spread across games; check each against the engine line.", "");
for (const c of CLASSIFICATION_ORDER) {
  const picks = rows.filter((r) => r.review.classification === c);
  if (!picks.length) continue;
  const step = Math.max(1, Math.floor(picks.length / 4));
  lines.push(`### ${CLASSIFICATION_LABELS[c]}`, "");
  for (const { review: r, game } of picks.filter((_, i) => i % step === 0).slice(0, 4)) {
    const m = r.v2!.metrics;
    lines.push(
      `- **${moveNumberLabel(r.ply)} ${r.playedMoveSan}** (${r.mover}) in ${game.white.username}–${game.black.username}` +
        `${game.url ? ` · [game](${game.url})` : ""} · ply ${r.ply}  \n` +
        `  rank ${m.playedRank ?? "–"} · best ${r.bestMoveSan} · ${formatEvaluation(r.evaluationBefore)} → ${formatEvaluation(r.evaluationAfter)} · ` +
        `cp loss ${m.cpLoss} · Win% loss ${m.winPercentLoss.toFixed(1)} · ${m.resultClassBefore} → ${m.resultClassAfter}` +
        `${r.verified ? " · verified" : ""}  \n  > ${r.explanation}`,
    );
  }
  lines.push("");
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join("\n"));
console.log(`\n${lines.slice(0, 22).join("\n")}\n\nFull report: ${outFile}`);
await ctx.engine.dispose();
db.close();
process.exit(0);
