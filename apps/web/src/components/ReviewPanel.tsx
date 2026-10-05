import { useState } from "react";
import {
  CLASSIFICATION_LABELS,
  CLASSIFICATION_ORDER,
  moveNumberLabel,
  type AnalysisPresetName,
  type EngineAnalysis,
  type EngineLine,
  type JobInfo,
  type MoveBadge,
  type TacticalTag,
} from "@chessanalyser/shared";
import { ClassificationBadge, ClassificationLabel, EvalChip } from "@chessanalyser/ui";
import { api, ApiError } from "../api";
import { boardView, useApp } from "../store";

const TAG_LABELS: Record<TacticalTag | MoveBadge, { text: string; tone: "bad" | "good" | "neutral" }> = {
  hangs_piece: { text: "Hangs a piece", tone: "bad" },
  wins_material: { text: "Wins material", tone: "good" },
  loses_material: { text: "Loses material", tone: "bad" },
  misses_capture: { text: "Missed capture", tone: "bad" },
  allows_mate: { text: "Allows mate", tone: "bad" },
  misses_mate: { text: "Missed mate", tone: "bad" },
  missed_mate: { text: "Missed mate", tone: "bad" },
  missed_win: { text: "Missed win", tone: "bad" },
  creates_mate_threat: { text: "Mate threat", tone: "good" },
  allows_fork: { text: "Allows fork", tone: "bad" },
  back_rank_weakness: { text: "Back rank", tone: "bad" },
  removes_defender: { text: "Removes defender", tone: "good" },
};

export function ReviewPanel({ variationAnalysis }: { variationAnalysis: EngineAnalysis | null }) {
  const state = useApp();
  const { game, review, job, mode } = state;
  const view = boardView(state);
  if (!game || !mode || !view) return null;

  return (
    <div className="card panel">
      <AnalyseSection job={job} complete={!!review?.complete} supported={game.supported} gameId={game.id} />
      {view.inVariation ? (
        <VariationSection analysis={variationAnalysis} />
      ) : mode.type === "game" && mode.ply > 0 ? (
        <MoveSection ply={mode.ply} />
      ) : (
        <StartSection />
      )}
      {review && review.reviews.length > 0 && <SummarySection />}
      {(game.eco || game.openingName) && (
        <div className="panel-section">
          <h2>Opening</h2>
          <div>
            {game.eco && <strong>{game.eco}</strong>} {game.openingName}
          </div>
        </div>
      )}
    </div>
  );
}

function AnalyseSection({ job, complete, supported, gameId }: { job: JobInfo | null; complete: boolean; supported: boolean; gameId: string }) {
  const settings = useApp((s) => s.settings);
  const engine = useApp((s) => s.engine);
  const [preset, setPreset] = useState<AnalysisPresetName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = preset ?? settings?.defaultPreset ?? "standard";

  if (!supported) {
    return (
      <div className="panel-section">
        <strong>Variant not supported in V1</strong>
        <p className="muted" style={{ margin: "4px 0 0" }}>Only standard chess games can be analysed.</p>
      </div>
    );
  }

  const running = job && (job.state === "running" || job.state === "queued");
  const start = async () => {
    setError(null);
    try {
      const j = await api.post<JobInfo>(`/api/games/${gameId}/analyse`, { preset: chosen });
      useApp.setState({ job: j });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  if (running) {
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    const reviewing = job.done >= job.total;
    return (
      <div className="panel-section" aria-live="polite">
        <strong>{reviewing ? "Reviewing moves…" : "Analysing game"}</strong>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="analyse-row muted">
          {job.done} / {job.total} positions
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm btn-ghost" onClick={() => void api.del(`/api/jobs/${job.id}`)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const failed = job && (job.state === "failed" || job.state === "paused" || job.state === "cancelled");
  return (
    <div className="panel-section">
      {failed && job.state !== "cancelled" && <p className="error-text" style={{ marginTop: 0 }}>{job.error}</p>}
      {error && <p className="error-text" style={{ marginTop: 0 }}>{error}</p>}
      <div className="analyse-row">
        <button className="btn btn-primary" onClick={start} disabled={engine.state === "unavailable"} data-testid="analyse">
          {complete ? "Reanalyse" : failed ? "Retry analysis" : "Analyse game"}
        </button>
        <label className="visually-hidden" htmlFor="preset">
          Analysis depth
        </label>
        <select id="preset" className="select" value={chosen} onChange={(e) => setPreset(e.target.value as AnalysisPresetName)}>
          <option value="quick">Quick</option>
          <option value="standard">Standard</option>
          <option value="deep">Deep</option>
        </select>
      </div>
    </div>
  );
}

function BestLine({ line, startingPly, label }: { line: EngineLine; startingPly: number; label?: string }) {
  const { game, mode, showLine } = useApp();
  if (!game) return null;
  const activeIndex = mode?.type === "engineVariation" && mode.lineId === line.id ? mode.index : -1;
  const enter = (index: number) =>
    showLine({ lineId: line.id, gameId: game.id, startingPly, moves: line.moves, source: "review" }, index);
  return (
    <div>
      <div className="best-move">
        <span>
          <span className="muted">{label ?? "Best"}:</span>{" "}
          <strong>
            {moveNumberLabel(startingPly + 1)} {line.rootMoveSan}
          </strong>{" "}
          <EvalChip evaluation={line.evaluation} />
        </span>
        <button className="btn btn-sm" onClick={() => enter(1)} data-testid="show-best-line">
          Show best line
        </button>
      </div>
      <div className="line" aria-label="Best line">
        {line.moves.map((m, i) => {
          const ply = startingPly + 1 + i;
          const showNumber = i === 0 || ply % 2 === 1;
          return (
            <span key={i} style={{ display: "contents" }}>
              {showNumber && <span className="line-num">{moveNumberLabel(ply)}</span>}
              <button className="line-move" aria-current={activeIndex === i + 1} onClick={() => enter(i + 1)}>
                {m.san}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function MoveSection({ ply }: { ply: number }) {
  const { review, moves } = useApp();
  const r = review?.reviews.find((x) => x.ply === ply);
  const move = moves[ply - 1];
  const bestLine = review?.positions[ply - 1]?.bestLine;
  if (!move) return null;
  const tags = [...new Set([...(r?.badges ?? []), ...(r?.tags ?? [])])].filter((t) => t !== "misses_mate" || !r?.badges.includes("missed_mate"));
  return (
    <div className="panel-section" data-testid="move-review">
      <div className="panel-move">
        {r && <ClassificationBadge classification={r.classification} />}
        <span>
          {moveNumberLabel(ply)} {move.san}
        </span>
      </div>
      {r ? (
        <>
          <ClassificationLabel classification={r.classification} />
          <div className="eval-change" aria-label="Evaluation change">
            <EvalChip evaluation={r.evaluationBefore} /> <span className="muted">→</span> <EvalChip evaluation={r.evaluationAfter} />
          </div>
          <p className="explanation">{r.explanation}</p>
          {tags.length > 0 && (
            <div className="tags">
              {tags.map((t) => (
                <span key={t} className="tag" data-tone={TAG_LABELS[t].tone}>
                  {TAG_LABELS[t].text}
                </span>
              ))}
            </div>
          )}
          {bestLine && r.bestMoveUci !== r.playedMoveUci && r.classification !== "forced" && (
            <div style={{ marginTop: 12 }}>
              <BestLine line={bestLine} startingPly={ply - 1} />
            </div>
          )}
          {r.reduced && <p className="muted" style={{ marginBottom: 0 }}>Reduced review (Apple Chess fallback).</p>}
        </>
      ) : (
        <p className="muted">Not reviewed yet.</p>
      )}
    </div>
  );
}

function StartSection() {
  const { review, mode } = useApp();
  const ply = mode?.type === "game" ? mode.ply : 0;
  const best = review?.positions[ply]?.bestLine;
  return (
    <div className="panel-section">
      <h2>Starting position</h2>
      {best ? <BestLine line={best} startingPly={ply} label="Engine" /> : <p className="muted" style={{ margin: 0 }}>Step through the game with ← and →.</p>}
    </div>
  );
}

function VariationSection({ analysis }: { analysis: EngineAnalysis | null }) {
  const { mode, line, variation, moves, returnToGame, showVariation } = useApp();
  const branch = mode?.type === "engineVariation" ? line : variation;
  if (!branch || !mode) return null;
  const base = branch.startingPly;
  const from = base > 0 ? `${moveNumberLabel(base)} ${moves[base - 1]?.san ?? ""}` : "the starting position";
  const index = "index" in mode ? mode.index : 0;
  const lineEval = mode.type === "engineVariation" && line ? undefined : analysis?.evaluation;
  const save = async () => {
    if (!variation) return;
    showVariation(await api.post(`/api/variations/${variation.id}/save`, {}), index);
  };
  return (
    <div className="panel-section">
      <div className="mode-label">{mode.type === "engineVariation" ? "ENGINE LINE" : "VARIATION"}</div>
      <p style={{ margin: "4px 0 8px" }}>Analysing variation from {from}</p>
      {lineEval && (
        <div className="eval-change">
          <span className="muted">Engine:</span> <EvalChip evaluation={lineEval} />
          {analysis?.lines[0] && <span className="muted">best {analysis.lines[0].rootMoveSan}</span>}
        </div>
      )}
      <div className="analyse-row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={returnToGame} data-testid="return-to-game">
          Return to game
        </button>
        {variation && (
          <button className="btn btn-ghost" onClick={save} disabled={variation.saved}>
            {variation.saved ? "Saved" : "Save variation"}
          </button>
        )}
      </div>
      <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
        Move {index} of {branch.moves.length}. The original game is unchanged.
      </p>
    </div>
  );
}

function SummarySection() {
  const review = useApp((s) => s.review)!;
  const game = useApp((s) => s.game)!;
  const rows = CLASSIFICATION_ORDER.filter((c) => review.summary.white[c] + review.summary.black[c] > 0);
  return (
    <div className="panel-section">
      <h2>Game review</h2>
      <div className="summary-grid">
        <span />
        <span className="head">{game.white.username}</span>
        <span className="head">{game.black.username}</span>
        {rows.map((c) => (
          <span key={c} style={{ display: "contents" }}>
            <span className="summary-label">
              <ClassificationBadge classification={c} size="sm" /> {CLASSIFICATION_LABELS[c]}
            </span>
            <span className="count">{review.summary.white[c]}</span>
            <span className="count">{review.summary.black[c]}</span>
          </span>
        ))}
      </div>
      {!review.complete && <p className="muted" style={{ marginBottom: 0 }}>Partial review.</p>}
    </div>
  );
}
