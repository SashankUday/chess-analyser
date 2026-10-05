import { legalMoveCount, sideToMove } from "@chessanalyser/chess-core";
import {
  CLASSIFICATION_ORDER,
  REVIEW_ALGORITHM_VERSION,
  type EngineAnalysis,
  type GameMove,
  type MoveClassification,
  type MoveReview,
  type ReviewSummary,
} from "@chessanalyser/shared";
import { BrilliantDetector } from "./brilliant";
import { classifyWithCp, classifyWithWdl, isBorderline, type ClassificationResult } from "./classify";
import { explain } from "./explain";
import { cpFor, expectedFor, mateFor } from "./score";
import { detectTags } from "./tags";

/** Targeted engine searches the review may request (spec §13E and the borderline recheck). */
export interface ReviewVerifier {
  /** MultiPV 3, higher-budget search of the position before the move. */
  brilliant(fenBefore: string): Promise<EngineAnalysis>;
  /** Search of the position before the move restricted to one root move, at a fixed shared budget. */
  restricted(fenBefore: string, uci: string): Promise<EngineAnalysis>;
}

export interface ReviewMoveInput {
  gameId: string;
  move: GameMove;
  previousMove: GameMove | null;
  before: EngineAnalysis;
  after: EngineAnalysis;
  verifier?: ReviewVerifier;
  detector?: BrilliantDetector;
}

export async function reviewMove(input: ReviewMoveInput): Promise<MoveReview> {
  const { move, before, after, verifier } = input;
  const detector = input.detector ?? new BrilliantDetector();
  const mover = sideToMove(move.fenBefore);
  const bestLine = before.lines[0] ?? null;
  const playedIsBest = bestLine?.rootMoveUci === move.uci;
  const legalCount = legalMoveCount(move.fenBefore);
  const mateBefore = mateFor(before, mover);
  const mateAfter = mateFor(after, mover);

  const eBestRaw = expectedFor(before, mover);
  const ePlayedRaw = expectedFor(after, mover);
  const reduced = eBestRaw === null || ePlayedRaw === null;

  let result: ClassificationResult;
  let expectedBest: number | null = null;
  let expectedPlayed: number | null = null;
  let severity: number; // 0–1 scale used to decide whether a tactical pattern actually mattered
  let verified = false;

  if (!reduced) {
    expectedBest = eBestRaw;
    expectedPlayed = playedIsBest ? eBestRaw : ePlayedRaw;
    result = classifyWithWdl({ legalMoveCount: legalCount, playedIsBest, expectedBest, expectedPlayed, mateBefore, mateAfter });

    // Borderline recheck: compare both moves from the same position at the same budget.
    if (verifier && bestLine && !playedIsBest && result.classification !== "forced" && isBorderline(result.loss)) {
      const [vBest, vPlayed] = await Promise.all([
        verifier.restricted(move.fenBefore, bestLine.rootMoveUci),
        verifier.restricted(move.fenBefore, move.uci),
      ]);
      const eb = expectedFor(vBest, mover);
      const ep = expectedFor(vPlayed, mover);
      if (eb !== null && ep !== null) {
        expectedBest = eb;
        expectedPlayed = ep;
        result = classifyWithWdl({ legalMoveCount: legalCount, playedIsBest, expectedBest: eb, expectedPlayed: ep, mateBefore, mateAfter });
        verified = true;
      }
    }

    // Brilliant: deterministic screen, then targeted engine confirmation.
    if (
      verifier &&
      (result.classification === "best" || result.classification === "excellent") &&
      detector.isCandidate({ move, previousMove: input.previousMove, mover, loss: result.loss, after })
    ) {
      const confirmation = await verifier.brilliant(move.fenBefore);
      if (detector.confirm(confirmation, move, mover)) {
        result = { ...result, classification: "brilliant" };
        verified = true;
      }
    }
    severity = result.loss;
  } else {
    const cp = classifyWithCp({
      legalMoveCount: legalCount,
      playedIsBest,
      cpBest: cpFor(before, mover),
      cpPlayed: cpFor(after, mover),
      mateBefore,
      mateAfter,
    });
    result = cp;
    severity = Math.min(1, cp.cpLoss / 1000);
  }

  const tagResult =
    result.classification === "forced"
      ? { tags: [], badges: [], facts: {} }
      : detectTags({
          move,
          mover,
          before,
          after,
          loss: severity,
          playedIsBest,
          allowsMate: result.allowsMate,
          missedMate: result.missedMate,
        });
  const badges = [...new Set([...result.badges, ...tagResult.badges])];

  return {
    gameId: input.gameId,
    ply: move.ply,
    mover,
    playedMoveSan: move.san,
    playedMoveUci: move.uci,
    classification: result.classification,
    badges,
    evaluationBefore: before.evaluation,
    evaluationAfter: after.evaluation,
    expectedScoreBest: reduced ? null : expectedBest,
    expectedScorePlayed: reduced ? null : expectedPlayed,
    expectedScoreLoss: reduced ? null : result.loss,
    bestMoveSan: bestLine?.rootMoveSan ?? null,
    bestMoveUci: bestLine?.rootMoveUci ?? null,
    bestLineId: bestLine?.id ?? null,
    tags: tagResult.tags,
    explanation: explain({
      classification: result.classification,
      playedSan: move.san,
      bestSan: bestLine?.rootMoveSan ?? null,
      playedIsBest,
      tags: tagResult.tags,
      facts: tagResult.facts,
      badges,
      reduced,
    }),
    engine: before.engine,
    engineVersion: before.engineVersion,
    algorithmVersion: REVIEW_ALGORITHM_VERSION,
    verified,
    reduced,
  };
}

export interface ReviewGameInput {
  gameId: string;
  moves: GameMove[];
  /** Engine analysis per position; key = ply (0 is the starting position). */
  positions: Map<number, EngineAnalysis>;
  verifier?: ReviewVerifier;
  onReviewed?: (review: MoveReview) => void;
}

/** Review every played move whose before/after positions have been analysed. */
export async function reviewGame(input: ReviewGameInput): Promise<MoveReview[]> {
  const detector = new BrilliantDetector();
  const out: MoveReview[] = [];
  for (let i = 0; i < input.moves.length; i++) {
    const move = input.moves[i]!;
    const before = input.positions.get(move.ply - 1);
    const after = input.positions.get(move.ply);
    if (!before || !after) continue;
    const review = await reviewMove({
      gameId: input.gameId,
      move,
      previousMove: input.moves[i - 1] ?? null,
      before,
      after,
      verifier: input.verifier,
      detector,
    });
    out.push(review);
    input.onReviewed?.(review);
  }
  return out;
}

export function summarise(reviews: MoveReview[]): ReviewSummary {
  const empty = () =>
    Object.fromEntries(CLASSIFICATION_ORDER.map((c) => [c, 0])) as Record<MoveClassification, number>;
  const summary: ReviewSummary = { white: empty(), black: empty() };
  for (const r of reviews) summary[r.mover][r.classification] += 1;
  return summary;
}
