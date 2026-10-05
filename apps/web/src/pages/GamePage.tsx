import { useEffect, useMemo, useState } from "react";
import { checkedKingSquare } from "@chessanalyser/chess-core";
import type { EngineAnalysis, Variation } from "@chessanalyser/shared";
import { api, ApiError } from "../api";
import { ChessBoard, type BoardArrow } from "../components/ChessBoard";
import { EngineBanner } from "../components/EngineBanner";
import { EvalBar } from "../components/EvalBar";
import { EvalGraph } from "../components/EvalGraph";
import { MoveList } from "../components/MoveList";
import { ReviewPanel } from "../components/ReviewPanel";
import { socket } from "../socket";
import { boardView, useApp } from "../store";

export function GamePage({ gameId, initialPly }: { gameId: string; initialPly: number | null }) {
  const state = useApp();
  const { game, moves, review, mode, flipped, line, aiOverlays, error } = state;
  const view = boardView(state);
  const [variationAnalysis, setVariationAnalysis] = useState<EngineAnalysis | null>(null);

  useEffect(() => {
    useApp
      .getState()
      .openGame(gameId)
      .then(() => {
        if (initialPly !== null) useApp.getState().goToPly(initialPly);
      })
      .catch((err) => useApp.getState().setError(err instanceof ApiError ? err.message : String(err)));
    return () => useApp.getState().closeGame();
  }, [gameId, initialPly]);

  // Tell the backend what this tab is showing (AI writes resolve against it; spec §51).
  useEffect(() => {
    socket.send({ type: "ui.state", gameId: game?.id ?? null, ply: view ? view.basePly : null });
  }, [game?.id, view?.basePly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => socket.send({ type: "ui.state", gameId: null, ply: null }), []);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const s = useApp.getState();
      if (e.key === "ArrowLeft") s.step(-1);
      else if (e.key === "ArrowRight") s.step(1);
      else if (e.key === "Home") s.jump("start");
      else if (e.key === "End") s.jump("end");
      else if (e.key === "f") s.flip();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Evaluate positions inside a user variation on demand (interactive priority on the backend).
  const variationKey = mode?.type === "userVariation" ? `${mode.variationId}:${mode.index}` : null;
  useEffect(() => {
    setVariationAnalysis(null);
    if (mode?.type !== "userVariation" || mode.index === 0) return;
    const timer = setTimeout(() => {
      api
        .post<EngineAnalysis>(`/api/variations/${mode.variationId}/analyse`, { index: mode.index })
        .then((a) => setVariationAnalysis(a))
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [variationKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const arrows = useMemo<BoardArrow[]>(() => {
    const out: BoardArrow[] = [];
    if (mode?.type === "game") {
      const best = review?.positions[mode.ply]?.bestLine?.rootMoveUci;
      if (best) out.push({ from: best.slice(0, 2), to: best.slice(2, 4), role: "engine" });
    } else if (mode?.type === "engineVariation" && line) {
      const next = line.moves[mode.index];
      if (next) out.push({ from: next.uci.slice(0, 2), to: next.uci.slice(2, 4), role: "engine" });
    } else if (mode?.type === "userVariation") {
      const best = variationAnalysis?.lines[0]?.rootMoveUci;
      if (best) out.push({ from: best.slice(0, 2), to: best.slice(2, 4), role: "engine" });
    }
    for (const a of aiOverlays.arrows) out.push(a);
    return out;
  }, [mode, review, line, variationAnalysis, aiOverlays.arrows]);

  if (error) {
    return (
      <div className="page">
        <div className="banner banner-error">{error}</div>
        <a href="#/">Back to games</a>
      </div>
    );
  }
  if (!game || !view || !mode) return <div className="page muted">Loading game…</div>;

  const onMove = async (uci: string) => {
    const s = useApp.getState();
    const m = s.mode;
    if (!m) return;
    try {
      if (m.type === "game") {
        if (s.moves[m.ply]?.uci === uci) return s.goToPly(m.ply + 1);
        const v = await api.post<Variation>("/api/variations", {
          gameId: game.id,
          startingPly: m.ply,
          move: uci,
          ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        });
        s.showVariation(v);
      } else if (m.type === "userVariation" && s.variation) {
        if (s.variation.moves[m.index]?.uci === uci) return s.step(1);
        const v = await api.post<Variation>(`/api/variations/${s.variation.id}/moves`, { atIndex: m.index, move: uci });
        s.showVariation(v, m.index + 1);
      } else if (m.type === "engineVariation" && s.line) {
        if (s.line.moves[m.index]?.uci === uci) return s.step(1);
        // Branch off the engine line into a user variation: replay its first moves, then the new one.
        const prefix = s.line.moves.slice(0, m.index).map((x) => x.uci);
        const all = [...prefix, uci];
        let v = await api.post<Variation>("/api/variations", {
          gameId: game.id,
          startingPly: s.line.startingPly,
          move: all[0],
          ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        });
        for (let i = 1; i < all.length; i++) {
          v = await api.post<Variation>(`/api/variations/${v.id}/moves`, { atIndex: i, move: all[i] });
        }
        s.showVariation(v);
      }
    } catch (err) {
      // Illegal moves never reach here (the board only offers legal ones); surface anything else.
      console.warn("Move rejected", err);
    }
  };

  const orientation = flipped ? "black" : "white";
  const top = flipped ? game.white : game.black;
  const bottom = flipped ? game.black : game.white;
  const lastTo = view.lastMoveUci?.slice(2, 4);
  const position = view.position;
  // Engine lines keep the branch position's evaluation (the principal variation preserves it);
  // user variations are evaluated on demand.
  const branchEval = mode.type === "engineVariation" && line ? review?.positions[line.startingPly] : null;
  const evaluation =
    mode.type === "engineVariation"
      ? (branchEval?.evaluation ?? null)
      : mode.type === "userVariation"
        ? (variationAnalysis?.evaluation ?? null)
        : (position?.evaluation ?? null);
  const wdl =
    mode.type === "engineVariation" ? branchEval?.wdl : mode.type === "userVariation" ? variationAnalysis?.wdl : position?.wdl;
  const currentPly = mode.type === "game" ? mode.ply : null;

  return (
    <div className="page">
      <EngineBanner />
      <div className="review-layout">
        <div className="area-board">
          <div className="board-row">
            <EvalBar evaluation={evaluation} wdl={wdl} flipped={flipped} />
            <div className="board-column">
              <div className="player-strip">
                <span>
                  {top.username} <span className="rating">({top.rating ?? "?"})</span>
                </span>
                {view.inVariation && <span className="mode-label">VARIATION</span>}
              </div>
              <div className="board-frame">
                <ChessBoard
                  fen={view.fen}
                  orientation={orientation}
                  lastMove={view.lastMoveUci}
                  checkSquare={checkedKingSquare(view.fen)}
                  arrows={arrows}
                  highlights={aiOverlays.squares}
                  badge={view.lastClassification && lastTo ? { square: lastTo, classification: view.lastClassification } : null}
                  onMove={game.supported ? (uci) => void onMove(uci) : undefined}
                />
              </div>
              <div className="player-strip">
                <span>
                  {bottom.username} <span className="rating">({bottom.rating ?? "?"})</span>
                </span>
                <span className="muted">{game.result}</span>
              </div>
              <div className="board-controls" role="toolbar" aria-label="Board controls">
                <button className="btn btn-icon" onClick={() => state.jump("start")} aria-label="Start" title="Start (Home)">
                  ⏮
                </button>
                <button className="btn btn-icon" onClick={() => state.step(-1)} aria-label="Back" title="Back (←)" data-testid="back">
                  ◀
                </button>
                <button className="btn btn-icon" onClick={() => state.step(1)} aria-label="Forward" title="Forward (→)" data-testid="forward">
                  ▶
                </button>
                <button className="btn btn-icon" onClick={() => state.jump("end")} aria-label="End" title="End (End)">
                  ⏭
                </button>
                <button className="btn btn-icon" onClick={state.flip} aria-label="Flip board" title="Flip board (F)">
                  ⇅
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="area-graph card graph-card">
          <h2>Evaluation</h2>
          <EvalGraph
            positions={review?.positions ?? []}
            moves={moves}
            reviews={review?.reviews ?? []}
            currentPly={currentPly}
            onSelect={(ply) => state.goToPly(ply)}
          />
        </div>

        <div className="area-panel">
          <ReviewPanel variationAnalysis={variationAnalysis} />
        </div>

        <div className="area-moves">
          <MoveList />
        </div>
      </div>
    </div>
  );
}
