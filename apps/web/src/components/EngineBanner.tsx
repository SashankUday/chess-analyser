import { api } from "../api";
import { useApp } from "../store";

/** Engine status messages (spec §18, §59). The fallback engine never masquerades as Stockfish. */
export function EngineBanner() {
  const engine = useApp((s) => s.engine);
  const job = useApp((s) => s.job);

  if (engine.state === "installing") {
    const pct = engine.progress !== undefined ? ` ${Math.round(engine.progress * 100)}%` : "";
    return (
      <div className="banner" role="status">
        <strong>{engine.message}</strong>
        <span className="muted">{pct}</span>
      </div>
    );
  }
  if (engine.state === "ready" && engine.fallback) {
    return (
      <div className="banner banner-warn" role="status">
        <strong>Engine: Apple Chess fallback</strong>
        <span>Stockfish is currently unavailable. Some advanced review features may be reduced.</span>
        <button className="btn btn-sm" onClick={() => void api.post("/api/engine/retry")}>
          Retry Stockfish
        </button>
      </div>
    );
  }
  if (engine.state === "unavailable") {
    const paused = engine.error.includes("paused");
    return (
      <div className="banner banner-error" role="alert">
        <strong>{paused ? "Stockfish stopped unexpectedly." : engine.downloadFailed ? "Unable to download Stockfish." : "No chess engine available."}</strong>
        <span>{paused ? "Analysis was paused." : engine.error}</span>
        <span style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => void api.post("/api/engine/retry")}>
          Retry
        </button>
        <a className="btn btn-sm btn-ghost" href="#/settings">
          View setup details
        </a>
      </div>
    );
  }
  if (job?.state === "paused") {
    return (
      <div className="banner banner-error" role="alert">
        <strong>Stockfish stopped unexpectedly.</strong> Analysis was paused.
      </div>
    );
  }
  return null;
}
