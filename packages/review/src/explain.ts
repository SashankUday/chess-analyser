import type { MoveClassification, MoveReview, TacticalTag } from "@chessanalyser/shared";
import type { TagResult } from "./tags";

export interface ExplanationInput {
  classification: MoveClassification;
  playedSan: string;
  bestSan: string | null;
  playedIsBest: boolean;
  tags: TacticalTag[];
  facts: TagResult["facts"];
  badges: MoveReview["badges"];
  reduced: boolean;
}

const pawns = (n: number) => (n === 1 ? "a pawn" : `${n} pawns' worth of material`);

/** Deterministic, engine-backed explanation (spec §14). No LLM involved. */
export function explain(input: ExplanationInput): string {
  const { classification, bestSan, playedIsBest, tags, facts } = input;
  const sentences: string[] = [];
  const better = bestSan && !playedIsBest ? bestSan : null;

  switch (classification) {
    case "forced":
      return "This was the only legal move.";
    case "brilliant":
      sentences.push(
        "A brilliant move: it gives up material, but Stockfish confirms it is as strong as anything in the position.",
      );
      break;
    case "best":
      sentences.push(playedIsBest ? "This is the engine's preferred move." : "This is as strong as the engine's top choice.");
      break;
    case "excellent":
      sentences.push(better ? `An excellent move, nearly as strong as ${better}.` : "An excellent move.");
      break;
    case "good":
      sentences.push(better ? `A good move, though ${better} was stronger.` : "A good move.");
      break;
    case "inaccuracy":
      sentences.push(better ? `An inaccuracy. ${better} was better.` : "An inaccuracy.");
      break;
    case "mistake":
      sentences.push(
        better ? `A mistake that gives up a significant part of your chances. ${better} was much stronger.` : "A mistake.",
      );
      break;
    case "blunder":
      sentences.push(
        better ? `A blunder that loses substantial winning chances. ${better} was best.` : "A blunder.",
      );
      break;
  }

  if (tags.includes("allows_mate")) {
    sentences.push(
      facts.mateIn ? `This allows a forced mate in ${facts.mateIn}.` : "This allows a forced mate.",
    );
    if (tags.includes("back_rank_weakness")) sentences.push("The king is trapped on the back rank.");
  } else if (tags.includes("misses_mate")) {
    sentences.push(
      facts.mateIn && better
        ? `There was a forced mate in ${facts.mateIn} starting with ${better}.`
        : "There was a forced mate.",
    );
  } else if (tags.includes("hangs_piece") && facts.hungPiece) {
    sentences.push(`This move hangs the ${facts.hungPiece}${facts.hungSquare ? ` on ${facts.hungSquare}` : ""}.`);
  } else if (tags.includes("loses_material") && facts.lostMaterial && facts.refutation) {
    sentences.push(`Stockfish's reply wins ${pawns(Math.round(facts.lostMaterial))} for the opponent: ${facts.refutation}`);
  } else if (tags.includes("loses_material") && facts.lostMaterial) {
    sentences.push(`This move loses ${pawns(Math.round(facts.lostMaterial))}.`);
  }

  if (tags.includes("misses_capture") && facts.missedCaptureSan && !tags.includes("misses_mate")) {
    sentences.push(`${facts.missedCaptureSan} would have won material.`);
  }
  if (tags.includes("allows_fork") && facts.forkReplySan && !tags.includes("allows_mate")) {
    sentences.push(`It allows ${facts.forkReplySan}, a fork.`);
  }
  if (input.badges.includes("missed_win") && !tags.includes("misses_mate")) {
    sentences.push("This gives up most of the winning advantage.");
  }
  if (tags.includes("wins_material") && facts.wonMaterial && classification !== "brilliant") {
    sentences.push(`It wins ${pawns(Math.round(facts.wonMaterial))}.`);
  }
  if (tags.includes("creates_mate_threat") && !tags.includes("wins_material")) {
    sentences.push("It creates a mate threat.");
  }
  if (tags.includes("removes_defender")) sentences.push("It removes a key defender.");
  if (input.reduced) sentences.push("(Reduced review: Apple Chess fallback.)");

  return sentences.join(" ");
}
