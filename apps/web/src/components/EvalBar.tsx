import { formatEvaluation, whiteBarFraction, type NormalisedEvaluation, type Wdl } from "@chessanalyser/shared";

/** Vertical bar of White's expected result (spec §7). Uses WDL when the engine provides it. */
export function EvalBar({
  evaluation,
  wdl,
  flipped,
}: {
  evaluation: NormalisedEvaluation | null;
  wdl?: Wdl;
  flipped: boolean;
}) {
  const fraction = evaluation ? whiteBarFraction(evaluation, wdl) : 0.5;
  const text = evaluation ? formatEvaluation(evaluation) : "";
  const whiteAhead = fraction >= 0.5;
  // The label sits at the leading side's end of the bar.
  const atWhiteEnd = whiteAhead;
  const side = atWhiteEnd !== flipped ? "bottom" : "top";
  return (
    <div
      className="eval-bar"
      data-flipped={flipped}
      data-cp-only={!!evaluation && !wdl && evaluation.mateForWhiteIn === null && !evaluation.terminal}
      role="meter"
      aria-label="Evaluation"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuetext={text || "No evaluation"}
      title={wdl ? `White ${Math.round(wdl.whiteWin * 100)}% · Draw ${Math.round(wdl.draw * 100)}% · Black ${Math.round(wdl.blackWin * 100)}%` : text}
    >
      <div className="eval-bar-white" style={{ height: `${fraction * 100}%` }} />
      {text && (
        <span className="eval-bar-label" data-side={side} data-on={whiteAhead ? "light" : "dark"}>
          {text.replace(/^\+/, "")}
        </span>
      )}
    </div>
  );
}
