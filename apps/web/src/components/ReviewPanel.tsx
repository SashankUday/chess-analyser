import { useEffect, useState } from "react";
import {
  CLASSIFICATION_LABELS,
  CLASSIFICATION_ORDER,
  LINE_DISPLAY_PLIES,
  REVIEW_ALGORITHM_VERSION,
  formatEvaluation,
  moveNumberLabel,
  type AnalysisPresetName,
  type EngineAnalysis,
  type EngineLine,
  type JobInfo,
  type MoveBadge,
  type MoveReview,
  type TacticalTag,
  type Variation,
} from "@chessanalyser/shared";
import { ClassificationBadge, EvalChip } from "@chessanalyser/ui";
import { api, ApiError } from "../api";
import { useApp } from "../store";

const TAG_LABELS: Record<TacticalTag | MoveBadge, { text: string; tone: "bad" | "good" | "neutral" }> = {
  hangs_piece: { text: "Hangs a piece", tone: "bad" },
  wins_material: { text: "Wins material", tone: "good" },
  loses_material: { text: "Loses material", tone: "bad" },
  misses_capture: { text: "Missed material", tone: "bad" },
  allows_mate: { text: "Allows mate", tone: "bad" },
  misses_mate: { text: "Missed mate", tone: "bad" },
  missed_mate: { text: "Miss · mate", tone: "bad" },
  missed_win: { text: "Miss · winning position", tone: "bad" },
  missed_material: { text: "Miss · material", tone: "bad" },
  only_move: { text: "Only move", tone: "good" },
  creates_mate_threat: { text: "Mate threat", tone: "good" },
  allows_fork: { text: "Allows fork", tone: "bad" },
  back_rank_weakness: { text: "Back rank", tone: "bad" },
  removes_defender: { text: "Removes defender", tone: "good" },
};

export function debugReviewEnabled(): boolean {
  return new URLSearchParams(location.search).get("debugReview") === "1" || /[?&]debugReview=1/.test(location.hash);
}

export interface ReviewPanelProps {
  variationAnalysis: EngineAnalysis | null;
  branches: Variation[];
  /** Play these UCI moves into the current user variation (continuation clicks). */
  playUserMoves: (ucis: string[]) => void;
}

export function ReviewPanel(props: ReviewPanelProps) {
  const game = useApp((s) => s.game);
  const review = useApp((s) => s.review);
  const job = useApp((s) => s.job);
  const mode = useApp((s) => s.mode);
  if (!game || !mode) return null;
  const inVariation = mode.type !== "game";
  return (
    <div className="card panel">
      {review?.algorithmVersion !== null && review?.algorithmVersion !== undefined && review.algorithmVersion < REVIEW_ALGORITHM_VERSION && (
        <VersionBanner version={review.algorithmVersion} gameId={game.id} />
      )}
      <AnalyseSection job={job} complete={!!review?.complete} supported={game.supported} gameId={game.id} />
      {inVariation ? (
        <VariationSection {...props} />
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

function VersionBanner({ version, gameId }: { version: number; gameId: string }) {
  const reanalyse = () =>
    void api.post<JobInfo>(`/api/games/${gameId}/analyse`, {}).then((j) => useApp.setState({ job: j }));
  return (
    <div className="version-banner">
      <span>
        Analysed with Review Algorithm {version}.
      </span>
      <button className="btn btn-sm" onClick={reanalyse} data-testid="reanalyse-v2">
        Reanalyse with V{REVIEW_ALGORITHM_VERSION}
      </button>
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
        <strong>{reviewing ? "Reviewing moves (same-root checks, verification)…" : "Analysing game"}</strong>
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

/** Clickable engine continuation (6–10 plies). Clicking enters ENGINE VARIATION mode. */
function EngineLineView({ line, startingPly, label, testId }: { line: EngineLine; startingPly: number; label: string; testId?: string }) {
  const game = useApp((s) => s.game);
  const mode = useApp((s) => s.mode);
  const showLine = useApp((s) => s.showLine);
  if (!game) return null;
  const activeIndex = mode?.type === "engineVariation" && mode.lineId === line.id ? mode.index : -1;
  const moves = line.moves.slice(0, LINE_DISPLAY_PLIES);
  const enter = (index: number) => showLine({ lineId: line.id, gameId: game.id, startingPly, moves, source: "review" }, index);
  return (
    <div style={{ marginTop: 12 }}>
      <div className="best-move">
        <span>
          <span className="muted">{label}:</span>{" "}
          <strong>
            {moveNumberLabel(startingPly + 1)} {line.rootMoveSan}
          </strong>{" "}
          <EvalChip evaluation={line.evaluation} />
        </span>
        <button className="btn btn-sm" onClick={() => enter(1)} data-testid={testId}>
          Show line
        </button>
      </div>
      <div className="line" aria-label={label}>
        {moves.map((m, i) => {
          const ply = startingPly + 1 + i;
          return (
            <span key={i} style={{ display: "contents" }}>
              {(i === 0 || ply % 2 === 1) && <span className="line-num">{moveNumberLabel(ply)}</span>}
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

/** Fetch a stored engine line by id (e.g. the line that demonstrates an explanation). */
function useLine(lineId: string | null | undefined): EngineLine | null {
  const [loaded, setLoaded] = useState<EngineLine | null>(null);
  useEffect(() => {
    if (!lineId) return;
    let cancelled = false;
    api
      .get<EngineLine>(`/api/lines/${lineId}`)
      .then((l) => !cancelled && setLoaded(l))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lineId]);
  return lineId && loaded?.id === lineId ? loaded : null;
}

function MoveSection({ ply }: { ply: number }) {
  const review = useApp((s) => s.review);
  const moves = useApp((s) => s.moves);
  const r = review?.reviews.find((x) => x.ply === ply);
  const move = moves[ply - 1];
  const bestLineFromPosition = review?.positions[ply - 1]?.bestLine;
  const reviewBestLine = useLine(r?.bestLineId && r.bestLineId !== bestLineFromPosition?.id ? r.bestLineId : null);
  const bestLine = reviewBestLine ?? bestLineFromPosition;
  const consequenceLineId =
    r?.v2?.explanation.lineId && r.v2.explanation.lineId !== bestLine?.id ? r.v2.explanation.lineId : null;
  const consequenceLine = useLine(consequenceLineId);
  if (!move) return null;
  const v2 = r?.v2;
  const tags = [...new Set([...(r?.badges ?? []), ...(r?.tags ?? [])])].filter(
    (t) => !(t === "misses_mate" && r?.badges.includes("missed_mate")) && !(t === "misses_capture" && r?.badges.includes("missed_material")),
  );
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
          <div className={`classification-title qc-${r.classification}`}>{v2?.explanation.headline ?? CLASSIFICATION_LABELS[r.classification]}</div>
          <div className="eval-change" aria-label="Evaluation change">
            <EvalChip evaluation={r.evaluationBefore} /> <span className="muted">→</span> <EvalChip evaluation={r.evaluationAfter} />
          </div>
          {v2 && <MetricsRow review={r} />}
          <p className="explanation" data-testid="explanation">
            {r.explanation}
          </p>
          {tags.length > 0 && (
            <div className="tags">
              {tags.map((t) => (
                <span key={t} className="tag" data-tone={TAG_LABELS[t].tone}>
                  {TAG_LABELS[t].text}
                </span>
              ))}
            </div>
          )}
          {consequenceLine && <EngineLineView line={consequenceLine} startingPly={ply - 1} label="What happens" testId="show-consequence-line" />}
          {bestLine && r.bestMoveUci !== r.playedMoveUci && r.classification !== "forced" && (
            <EngineLineView line={bestLine} startingPly={ply - 1} label="Best" testId="show-best-line" />
          )}
          {r.reduced && <p className="muted" style={{ marginBottom: 0 }}>Reduced review (Apple Chess fallback).</p>}
          {debugReviewEnabled() && <DebugPanel review={r} />}
        </>
      ) : (
        <p className="muted">Not reviewed yet.</p>
      )}
    </div>
  );
}

function MetricsRow({ review }: { review: MoveReview }) {
  const m = review.v2!.metrics;
  return (
    <div className="metrics-row">
      <span>{m.playedRank === 1 ? "Engine's top move" : m.playedRank ? `Engine rank ${m.playedRank}` : "Not in the engine's top moves"}</span>
      {m.winPercentLoss >= 0.5 && <span>−{m.winPercentLoss.toFixed(1)}% winning chances</span>}
      {review.verified && <span title="Confirmed with a deeper same-position search">✓ verified</span>}
    </div>
  );
}

const fmtCp = (cp: number) => (Math.abs(cp) >= 9000 ? (cp > 0 ? "mate" : "-mate") : `${cp > 0 ? "+" : ""}${cp}`);

/** Developer diagnostics (`?debugReview=1`, V2 plan §46). */
function DebugPanel({ review: r }: { review: MoveReview }) {
  const v2 = r.v2;
  if (!v2) return <div className="debug-panel">Review Algorithm {r.algorithmVersion}: no V2 diagnostics.</div>;
  const m = v2.metrics;
  const d = v2.diagnostics;
  const p = d.preliminaryMetrics;
  const pov = r.mover === "white" ? "White" : "Black";
  return (
    <div className="debug-panel" data-testid="debug-panel">
      {`Played: ${r.playedMoveSan}   Stockfish rank: ${m.playedRank ?? "–"}${m.sameSearch ? "" : " (searchmoves)"}
Best: ${r.bestMoveSan}
Best CP: ${fmtCp(m.bestCp)} from ${pov} POV
Played CP: ${fmtCp(m.playedCp)} from ${pov} POV
CP loss: ${m.cpLoss}
Best Win%: ${m.bestWinPercent.toFixed(2)}   Played Win%: ${m.playedWinPercent.toFixed(2)}
Win% loss: ${m.winPercentLoss.toFixed(2)}   Criticality: ${m.criticality ?? "–"}
Result transition: ${m.resultClassBefore} → ${m.resultClassAfter}
Top moves: ${m.rootMoves.map((x) => `${x.san} ${fmtCp(x.cp)}`).join(", ")}
Preliminary: ${CLASSIFICATION_LABELS[d.preliminaryClassification]} (Win% loss ${p.winPercentLoss.toFixed(2)}, cp ${p.cpLoss})
Verification: ${d.verificationReasons.length ? d.verificationReasons.join("; ") : "not needed"}
Overrides: ${d.overrides.length ? d.overrides.join("; ") : "none"}
Final: ${CLASSIFICATION_LABELS[r.classification]}${r.verified ? " (verified)" : ""}
Explanation confidence: ${v2.explanation.confidence}
Engine: ${v2.engineConfig.engine} · ${v2.engineConfig.nodes} nodes · MultiPV ${v2.engineConfig.multiPv} · verify ${v2.engineConfig.verificationNodes} · threads ${v2.engineConfig.threads ?? "?"} · hash ${v2.engineConfig.hashMb ?? "?"} MB · Review Algorithm ${r.algorithmVersion}`}
      {d.brilliant && (
        <>
          {"\n\nBrilliant check:\n"}
          {d.brilliant.checks.map((c, i) => (
            <span key={i} className={c.pass ? "pass" : "fail"}>
              {`${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}\n`}
            </span>
          ))}
          {`→ ${d.brilliant.result ? "BRILLIANT" : "not Brilliant"}`}
        </>
      )}
      {d.great && d.great.length > 0 && (
        <>
          {"\n\nGreat check:\n"}
          {d.great.map((c, i) => (
            <span key={i} className={c.pass ? "pass" : "fail"}>
              {`${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}\n`}
            </span>
          ))}
        </>
      )}
      {v2.insightsBefore?.threats.length ? `\n\nThreats before: ${v2.insightsBefore.threats.map((t) => `${t.side} ${t.description}`).join("; ")}` : ""}
      {v2.insightsAfter?.threats.length ? `\nThreats after: ${v2.insightsAfter.threats.map((t) => `${t.side} ${t.description}`).join("; ")}` : ""}
    </div>
  );
}

function StartSection() {
  const review = useApp((s) => s.review);
  const mode = useApp((s) => s.mode);
  const ply = mode?.type === "game" ? mode.ply : 0;
  const best = review?.positions[ply]?.bestLine;
  return (
    <div className="panel-section">
      <h2>Starting position</h2>
      {best ? (
        <EngineLineView line={best} startingPly={ply} label="Engine" testId="show-best-line" />
      ) : (
        <p className="muted" style={{ margin: 0 }}>Step through the game with ← and →.</p>
      )}
    </div>
  );
}

function VariationSection({ variationAnalysis: analysis, branches, playUserMoves }: ReviewPanelProps) {
  const mode = useApp((s) => s.mode);
  const line = useApp((s) => s.line);
  const variation = useApp((s) => s.variation);
  const moves = useApp((s) => s.moves);
  const returnToGame = useApp((s) => s.returnToGame);
  const showVariation = useApp((s) => s.showVariation);
  const branch = mode?.type === "engineVariation" ? line : variation;
  if (!branch || !mode || mode.type === "game") return null;
  const base = branch.startingPly;
  const fromMove = base > 0 ? `${moveNumberLabel(base)} ${moves[base - 1]?.san ?? ""}` : "the starting position";
  const index = mode.index;

  if (mode.type === "engineVariation") {
    return (
      <div className="panel-section">
        <div className="mode-label">ENGINE VARIATION</div>
        <p style={{ margin: "4px 0 8px" }}>
          Showing Stockfish's preferred continuation from move {Math.ceil((base + 1) / 2)} (after {fromMove}).
        </p>
        <button className="btn" onClick={returnToGame} data-testid="return-to-game">
          Return to game
        </button>
        <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
          Move {index} of {branch.moves.length}. These are engine moves, not moves from the game.
        </p>
      </div>
    );
  }

  const save = async () => {
    if (!variation) return;
    showVariation(await api.post(`/api/variations/${variation.id}/save`, {}), index);
  };
  const best = analysis?.lines[0];
  const positionPly = base + index; // plies from the game start to the shown position
  const continuation = best ? best.moves.slice(0, LINE_DISPLAY_PLIES) : [];
  return (
    <div className="panel-section" data-testid="user-variation">
      <div className="mode-label" data-mode="user">
        YOUR VARIATION
      </div>
      <p style={{ margin: "4px 0 8px" }}>Starting from move {Math.ceil((base + 1) / 2)} (after {fromMove}).</p>
      <div className="line">
        {variation!.moves.map((m, i) => {
          const p = base + 1 + i;
          return (
            <span key={i} style={{ display: "contents" }}>
              {(i === 0 || p % 2 === 1) && <span className="line-num">{moveNumberLabel(p)}</span>}
              <button className="line-move user-move" aria-current={index === i + 1} onClick={() => showVariation(variation!, i + 1)}>
                {m.san}
              </button>
            </span>
          );
        })}
      </div>
      <div className="eval-change">
        <span className="muted">Evaluation:</span>{" "}
        {analysis ? <EvalChip evaluation={analysis.evaluation} /> : <span className="muted">analysing…</span>}
      </div>
      {best && (
        <>
          <p style={{ margin: "8px 0 0" }}>
            <span className="muted">Best {index === 0 ? "move" : "response"}:</span>{" "}
            <strong>
              {moveNumberLabel(positionPly + 1)} {best.rootMoveSan}
            </strong>
          </p>
          <div className="section-title muted" style={{ marginTop: 8, fontSize: 11, fontWeight: 700 }}>
            BEST CONTINUATION
          </div>
          <div className="line" data-testid="best-continuation">
            {continuation.map((m, i) => {
              const p = positionPly + 1 + i;
              return (
                <span key={i} style={{ display: "contents" }}>
                  {(i === 0 || p % 2 === 1) && <span className="line-num">{moveNumberLabel(p)}</span>}
                  <button
                    className="line-move"
                    title="Play this continuation into your variation"
                    onClick={() => playUserMoves(continuation.slice(0, i + 1).map((x) => x.uci))}
                  >
                    {m.san}
                  </button>
                </span>
              );
            })}
          </div>
        </>
      )}
      {branches.length > 1 && (
        <div className="branch-list" aria-label="Branches">
          <span className="muted" style={{ fontSize: 12 }}>
            Branches
          </span>
          {branches.map((b) => (
            <button key={b.id} className="btn btn-sm btn-ghost" aria-pressed={b.id === variation?.id} onClick={() => showVariation(b)}>
              {b.id === variation?.id ? "● " : "○ "}
              {b.moves.map((m) => m.san).join(" ")}
            </button>
          ))}
        </div>
      )}
      <div className="analyse-row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={returnToGame} data-testid="return-to-game">
          Return to game
        </button>
        <button className="btn btn-ghost" onClick={save} disabled={variation?.saved}>
          {variation?.saved ? "Saved" : "Save variation"}
        </button>
      </div>
      <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
        Your moves are hypothetical. The original game is unchanged. {analysis && `Engine: ${formatEvaluation(analysis.evaluation)}`}
      </p>
    </div>
  );
}

function SummarySection() {
  const review = useApp((s) => s.review)!;
  const game = useApp((s) => s.game)!;
  const rows = CLASSIFICATION_ORDER.filter((c) => review.summary.white[c] + review.summary.black[c] > 0);
  const misses = (colour: "white" | "black") =>
    review.reviews.filter((r) => r.mover === colour && r.badges.some((b) => b.startsWith("missed_"))).length;
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
        {misses("white") + misses("black") > 0 && (
          <span style={{ display: "contents" }}>
            <span className="summary-label">Miss</span>
            <span className="count">{misses("white")}</span>
            <span className="count">{misses("black")}</span>
          </span>
        )}
      </div>
      {!review.complete && <p className="muted" style={{ marginBottom: 0 }}>Partial review.</p>}
    </div>
  );
}
