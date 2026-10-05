// Shared presentational components. No chess logic and no data fetching here.
import {
  CLASSIFICATION_LABELS,
  formatEvaluation,
  type MoveClassification,
  type NormalisedEvaluation,
} from "@chessanalyser/shared";

const GLYPHS: Record<MoveClassification, string> = {
  brilliant: "!!",
  great: "!",
  best: "★",
  excellent: "✓",
  good: "·",
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
  forced: "→",
};

export function ClassificationBadge({ classification, size = "md" }: { classification: MoveClassification; size?: "sm" | "md" }) {
  return (
    <span
      className={`q-badge q-${classification}${size === "sm" ? " q-badge-sm" : ""}`}
      role="img"
      aria-label={CLASSIFICATION_LABELS[classification]}
      title={CLASSIFICATION_LABELS[classification]}
    >
      {GLYPHS[classification]}
    </span>
  );
}

export function ClassificationLabel({ classification }: { classification: MoveClassification }) {
  return <span className={`classification-title qc-${classification}`}>{CLASSIFICATION_LABELS[classification]}</span>;
}

/** Engine evaluation chip; the side that is better determines its colouring. */
export function EvalChip({ evaluation }: { evaluation: NormalisedEvaluation }) {
  const text = formatEvaluation(evaluation);
  const blackBetter =
    evaluation.terminal?.winner === "black" ||
    (evaluation.mateForWhiteIn !== null ? evaluation.mateForWhiteIn < 0 : (evaluation.whiteCp ?? 0) < 0);
  return (
    <span className="eval-chip" data-side={blackBetter ? "black" : "white"}>
      {text}
    </span>
  );
}
