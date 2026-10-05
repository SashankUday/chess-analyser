import { useEffect, useRef } from "react";
import { moveNumberLabel } from "@chessanalyser/shared";
import { ClassificationBadge } from "@chessanalyser/ui";
import { useApp } from "../store";

/** Played moves with their classifications, plus the active variation (spec §44). */
export function MoveList() {
  const { moves, review, mode, line, variation, goToPly, returnToGame } = useApp();
  const current = useRef<HTMLButtonElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const ply = mode?.type === "game" ? mode.ply : null;

  // Keep the current move visible by scrolling the list itself — never the page (V2 plan §44).
  useEffect(() => {
    const el = current.current;
    const box = table.current;
    if (box && ply === 0) box.scrollTop = 0;
    if (!el || !box) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = Math.max(0, top - 4);
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 4;
  }, [ply]);

  if (!mode) return null;
  const byPly = new Map(review?.reviews.map((r) => [r.ply, r]) ?? []);
  const branch = mode.type === "engineVariation" ? line : mode.type === "userVariation" ? variation : null;
  const rows = Math.ceil(moves.length / 2);

  return (
    <div className="card moves-card">
      {branch && "index" in mode && (
        <div className="variation-bar" data-testid="variation-bar" data-mode={mode.type === "engineVariation" ? "engine" : "user"}>
          <div>
            <div className="mode-label" data-mode={mode.type === "engineVariation" ? "engine" : "user"}>
              {mode.type === "engineVariation" ? "ENGINE VARIATION" : "YOUR VARIATION"}
            </div>
            <div className="line" style={{ marginTop: 2 }}>
              {branch.moves.map((m, i) => {
                const p = branch.startingPly + 1 + i;
                return (
                  <span key={i} style={{ display: "contents" }}>
                    {(i === 0 || p % 2 === 1) && <span className="line-num">{moveNumberLabel(p)}</span>}
                    <button
                      className={`line-move${mode.type === "userVariation" ? " user-move" : ""}`}
                      aria-current={mode.index === i + 1}
                      onClick={() => useApp.setState({ mode: { ...mode, index: i + 1 } })}
                    >
                      {m.san}
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
          <button className="btn btn-sm" onClick={returnToGame}>
            Return to game
          </button>
        </div>
      )}
      <h2>
        <span className="mode-label" style={{ marginRight: 8 }}>{branch ? "" : "GAME"}</span>Moves
      </h2>
      {moves.length === 0 ? (
        <p className="muted">No moves.</p>
      ) : (
        <div className="move-table" role="list" ref={table}>
          {Array.from({ length: rows }, (_, r) => {
            const white = moves[r * 2];
            const black = moves[r * 2 + 1];
            return (
              <div key={r} style={{ display: "contents" }} role="listitem">
                <span className="move-no">{r + 1}.</span>
                {[white, black].map((m) => {
                  if (!m) return <span key="empty" />;
                  const rev = byPly.get(m.ply);
                  const isCurrent = ply === m.ply;
                  return (
                    <button
                      key={m.ply}
                      ref={isCurrent ? current : undefined}
                      className="move-cell"
                      aria-current={isCurrent}
                      onClick={() => goToPly(m.ply)}
                      data-testid={`move-${m.ply}`}
                    >
                      {rev && <ClassificationBadge classification={rev.classification} size="sm" />}
                      {m.san}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
