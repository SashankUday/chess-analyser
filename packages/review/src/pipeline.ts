// Review Algorithm 2 pipeline (V2 plan §48).
import { legalMoveCount, materialSequence, sideToMove } from "@chessanalyser/chess-core";
import {
  CLASSIFICATION_ORDER,
  GREAT,
  MISS,
  REVIEW_ALGORITHM_VERSION,
  moverCp,
  moverHasMate,
  moverIsMated,
  moverMate,
  resultClass,
  type BrilliantDiagnostics,
  type Colour,
  type EngineAnalysis,
  type GameMove,
  type MoveBadge,
  type MoveClassification,
  type MoveReview,
  type PositionInsights,
  type ReviewEngineConfig,
  type ReviewSummary,
  type TacticalTag,
} from "@chessanalyser/shared";
import { BrilliantDetector } from "./brilliant";
import { applyOverrides, classifyMetrics, classifyReducedCp, maybeEquivalent, verificationReasons } from "./classify";
import { explainMove } from "./explain";
import { detectGreat } from "./great";
import { positionInsights } from "./insights";
import { computeMetrics, playedFromRestricted, playedFromRoot, type PlayedScore } from "./metrics";

/** Engine searches the reviewer may request. All run from exact game positions or their successors. */
export interface ReviewEngine {
  /** Search restricted to one root move (`go searchmoves`); `deep` uses the verification budget. */
  restricted(fen: string, uci: string, deep: boolean): Promise<EngineAnalysis>;
  /** MultiPV search at the verification budget. */
  deepRoot(fen: string): Promise<EngineAnalysis>;
  /** Small search of a hypothetical position (threat detection). */
  probe(fen: string): Promise<EngineAnalysis | null>;
}

export interface ReviewGameInput {
  gameId: string;
  moves: GameMove[];
  /** Same-root MultiPV analysis per position; key = ply (0 is the starting position). */
  positions: Map<number, EngineAnalysis>;
  engine?: ReviewEngine;
  engineConfig: ReviewEngineConfig;
  /** The importing user's colour, for "you" wording. */
  perspective?: Colour | null;
  onReviewed?: (review: MoveReview) => void;
}

export async function reviewGame(input: ReviewGameInput): Promise<MoveReview[]> {
  const insightCache = new Map<number, Promise<PositionInsights>>();
  const insightsAt = (ply: number, fen: string) => {
    let p = insightCache.get(ply);
    if (!p) {
      p = positionInsights(fen, { root: input.positions.get(ply) ?? null, probe: input.engine?.probe, ply });
      insightCache.set(ply, p);
    }
    return p;
  };
  const detector = new BrilliantDetector();
  const out: MoveReview[] = [];
  for (let i = 0; i < input.moves.length; i++) {
    const move = input.moves[i]!;
    const root = input.positions.get(move.ply - 1);
    const after = input.positions.get(move.ply);
    if (!root || !after) continue;
    const review = await reviewMoveV2({
      ...input,
      move,
      previousMove: input.moves[i - 1] ?? null,
      root,
      after,
      previousRoot: input.positions.get(move.ply - 2) ?? null,
      insightsBefore: () => insightsAt(move.ply - 1, move.fenBefore),
      insightsAfter: () => insightsAt(move.ply, move.fenAfter),
      detector,
    });
    out.push(review);
    input.onReviewed?.(review);
  }
  return out;
}

export interface ReviewMoveInput {
  gameId: string;
  move: GameMove;
  previousMove: GameMove | null;
  root: EngineAnalysis;
  after: EngineAnalysis;
  previousRoot: EngineAnalysis | null;
  engine?: ReviewEngine;
  engineConfig: ReviewEngineConfig;
  perspective?: Colour | null;
  insightsBefore?: () => Promise<PositionInsights>;
  insightsAfter?: () => Promise<PositionInsights>;
  detector?: BrilliantDetector;
}

export async function reviewMoveV2(input: ReviewMoveInput): Promise<MoveReview> {
  const { move, engine } = input;
  const mover = sideToMove(move.fenBefore);
  const legalCount = legalMoveCount(move.fenBefore);
  if (!input.root.capabilities.multipv) return reducedReview(input, mover, legalCount);

  // ---- Same-root comparison ----
  let root = input.root;
  let played: PlayedScore =
    playedFromRoot(root, move.uci) ??
    (engine
      ? playedFromRestricted(await engine.restricted(move.fenBefore, move.uci, false))
      : { evaluation: input.after.evaluation, rank: null, sameSearch: false, line: null });
  let metrics = computeMetrics(root, played, mover);
  const preliminaryMetrics = metrics;
  const preliminary = classifyMetrics(metrics, { legalMoveCount: legalCount });

  // ---- Verification of suspicious / borderline / possibly-equivalent results ----
  const bestEval0 = root.lines[0]?.evaluation ?? root.evaluation;
  const seq0 = played.line ? materialSequence(move.fenBefore, played.line.moves, mover) : null;
  const best0 = root.lines[0] ? materialSequence(move.fenBefore, root.lines[0].moves, mover) : null;
  const swing = Math.max(0, (best0?.net ?? 0) - (seq0?.net ?? 0));
  const mateChanged =
    moverHasMate(bestEval0, mover) !== moverHasMate(played.evaluation, mover) ||
    moverIsMated(bestEval0, mover) !== moverIsMated(played.evaluation, mover);
  const reasons = verificationReasons(metrics, preliminary, swing, mateChanged);
  let verified = false;
  let verifiedEquivalent = false;
  if (reasons.length && engine) {
    const deep = await engine.deepRoot(move.fenBefore);
    const deepPlayed = playedFromRoot(deep, move.uci) ?? playedFromRestricted(await engine.restricted(move.fenBefore, move.uci, true));
    root = deep;
    played = deepPlayed;
    metrics = computeMetrics(deep, deepPlayed, mover);
    verified = true;
    verifiedEquivalent = deepPlayed.rank !== 1 && maybeEquivalent(metrics);
  }

  // ---- Normal classification + overrides ----
  const bestLine = root.lines[0] ?? null;
  const bestEval = bestLine?.evaluation ?? root.evaluation;
  let classification = classifyMetrics(metrics, { legalMoveCount: legalCount, verifiedEquivalent });
  const playedSeq = played.line ? materialSequence(move.fenBefore, played.line.moves, mover) : null;
  const bestSeq = bestLine ? materialSequence(move.fenBefore, bestLine.moves, mover) : null;
  const missedMate = metrics.playedRank !== 1 && moverHasMate(bestEval, mover) && !moverHasMate(played.evaluation, mover);
  const flags = {
    allowsMate: moverIsMated(played.evaluation, mover) && !moverIsMated(bestEval, mover),
    missedMate,
    missedMateIn: missedMate ? moverMate(bestEval, mover) : null,
    forcedMaterialLoss: Math.max(0, -(playedSeq?.net ?? 0)),
  };
  const applied = applyOverrides(classification, metrics, flags);
  classification = applied.classification;
  const badges = new Set<MoveBadge>(applied.badges);
  if (metrics.playedRank !== 1 && bestSeq && bestSeq.net >= MISS.materialWin && (playedSeq?.net ?? 0) < bestSeq.net - 1) {
    badges.add("missed_material");
  }
  if (metrics.playedRank === 1 && (metrics.criticality ?? 0) >= GREAT.onlyMoveGap) badges.add("only_move");
  if (playedSeq && playedSeq.net >= 1 && metrics.winPercentLoss < 5) badges.add("wins_material");
  if (playedSeq && playedSeq.net <= -1 && metrics.winPercentLoss >= 5) badges.add("loses_material");

  // ---- Special detectors: Great, Brilliant ----
  const previousResultClass = input.previousRoot
    ? resultClass(input.previousRoot.lines[0]?.evaluation ?? input.previousRoot.evaluation, mover)
    : null;
  const great = detectGreat({ move, previousMove: input.previousMove, metrics, legalMoveCount: legalCount, previousResultClass });
  if (great.great && classification === "best") classification = "great";

  let brilliant: BrilliantDiagnostics | undefined;
  if (engine && (classification === "best" || classification === "great" || classification === "excellent")) {
    const diagnostics = await (input.detector ?? new BrilliantDetector()).evaluate({
      move,
      previousMove: input.previousMove,
      mover,
      metrics,
      legalMoveCount: legalCount,
      played,
      acceptance: (fen, uci) => engine.restricted(fen, uci, true),
      confirm: (fen) => engine.deepRoot(fen),
    });
    // Only keep diagnostics for real candidates (a sacrifice was found) to keep reviews small.
    if (diagnostics.checks.some((c) => c.name === "sacrifice detected" && c.pass) || diagnostics.result) brilliant = diagnostics;
    if (diagnostics.result) classification = "brilliant";
  }

  // ---- Position insights + explanation ----
  const insightsBefore = input.insightsBefore ? await input.insightsBefore() : null;
  const insightsAfter = input.insightsAfter ? await input.insightsAfter() : null;
  const badgeList = [...badges];
  const explanation = explainMove({
    move,
    mover,
    classification,
    metrics,
    badges: badgeList,
    bestLine,
    playedLine: played.line,
    insightsBefore,
    insightsAfter,
    perspective: input.perspective ?? null,
    greatReason: classification === "great" ? great.reason : null,
    sacrifice: classification === "brilliant" ? brilliant?.sacrifice : undefined,
    previousResultClass,
    reduced: false,
  });

  return {
    gameId: input.gameId,
    ply: move.ply,
    mover,
    playedMoveSan: move.san,
    playedMoveUci: move.uci,
    classification,
    badges: badgeList,
    evaluationBefore: bestEval,
    evaluationAfter: metrics.playedRank === 1 ? bestEval : played.evaluation,
    expectedScoreBest: null,
    expectedScorePlayed: null,
    expectedScoreLoss: null,
    bestMoveSan: bestLine?.rootMoveSan ?? null,
    bestMoveUci: bestLine?.rootMoveUci ?? null,
    bestLineId: bestLine?.id ?? null,
    tags: deriveTags(badgeList, insightsAfter, mover, classification),
    explanation: explanation.summary,
    engine: root.engine,
    engineVersion: root.engineVersion,
    algorithmVersion: REVIEW_ALGORITHM_VERSION,
    verified,
    reduced: false,
    v2: {
      metrics,
      insightsBefore,
      insightsAfter,
      explanation,
      diagnostics: {
        preliminaryClassification: preliminary,
        preliminaryMetrics,
        verificationReasons: reasons,
        overrides: applied.overrides,
        brilliant,
        great: great.checks,
      },
      engineConfig: input.engineConfig,
      playedLineId: played.line?.id ?? null,
    },
  };
}

function deriveTags(badges: MoveBadge[], after: PositionInsights | null, mover: Colour, c: MoveClassification): TacticalTag[] {
  const tags = new Set<TacticalTag>();
  if (badges.includes("allows_mate")) tags.add("allows_mate");
  if (badges.includes("missed_mate")) tags.add("misses_mate");
  if (badges.includes("loses_material")) tags.add("loses_material");
  if (badges.includes("wins_material")) tags.add("wins_material");
  if (badges.includes("missed_material")) tags.add("misses_capture");
  if (after?.mateThreat?.side === mover && c !== "blunder" && c !== "mistake") tags.add("creates_mate_threat");
  return [...tags];
}

/** Apple Chess/Sjeng: no MultiPV or searchmoves, so a sequential, conservative centipawn review. */
function reducedReview(input: ReviewMoveInput, mover: Colour, legalCount: number): MoveReview {
  const { move, root, after } = input;
  const bestLine = root.lines[0] ?? null;
  const playedIsBest = bestLine?.rootMoveUci === move.uci;
  const { classification } = classifyReducedCp({
    legalMoveCount: legalCount,
    playedIsBest,
    cpBest: moverCp(root.evaluation, mover),
    cpPlayed: moverCp(after.evaluation, mover),
  });
  const metrics = computeMetrics(root, { evaluation: after.evaluation, rank: playedIsBest ? 1 : null, sameSearch: false, line: null }, mover);
  const explanation = explainMove({
    move,
    mover,
    classification,
    metrics,
    badges: [],
    bestLine,
    playedLine: null,
    insightsBefore: null,
    insightsAfter: null,
    perspective: input.perspective ?? null,
    greatReason: null,
    previousResultClass: null,
    reduced: true,
  });
  return {
    gameId: input.gameId,
    ply: move.ply,
    mover,
    playedMoveSan: move.san,
    playedMoveUci: move.uci,
    classification,
    badges: [],
    evaluationBefore: root.evaluation,
    evaluationAfter: after.evaluation,
    expectedScoreBest: null,
    expectedScorePlayed: null,
    expectedScoreLoss: null,
    bestMoveSan: bestLine?.rootMoveSan ?? null,
    bestMoveUci: bestLine?.rootMoveUci ?? null,
    bestLineId: bestLine?.id ?? null,
    tags: [],
    explanation: explanation.summary,
    engine: root.engine,
    engineVersion: root.engineVersion,
    algorithmVersion: REVIEW_ALGORITHM_VERSION,
    verified: false,
    reduced: true,
    v2: {
      metrics,
      insightsBefore: null,
      insightsAfter: null,
      explanation,
      diagnostics: { preliminaryClassification: classification, preliminaryMetrics: metrics, verificationReasons: [], overrides: [] },
      engineConfig: input.engineConfig,
      playedLineId: null,
    },
  };
}

export function summarise(reviews: MoveReview[]): ReviewSummary {
  const empty = () => Object.fromEntries(CLASSIFICATION_ORDER.map((c) => [c, 0])) as Record<MoveClassification, number>;
  const summary: ReviewSummary = { white: empty(), black: empty() };
  for (const r of reviews) summary[r.mover][r.classification] += 1;
  return summary;
}
