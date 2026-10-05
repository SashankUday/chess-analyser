import { useEffect, useRef, useState } from "react";
import type { AiAccess } from "@chessanalyser/shared";
import { api, ApiError } from "../api";
import { useApp } from "../store";

const LABELS: Record<AiAccess["mode"], string> = {
  off: "OFF",
  current_game: "CURRENT GAME",
  library: "ENTIRE LIBRARY",
};

export function AiAccessPill() {
  const access = useApp((s) => s.aiAccess);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ai-pill" data-on={access.mode !== "off"} onClick={() => setOpen(true)} data-testid="ai-access">
        <span className="dot" aria-hidden />
        <span>
          <span className="ai-pill-prefix">AI Access: </span>
          <span className="ai-pill-short" aria-hidden>AI </span>
          {LABELS[access.mode]}
        </span>
      </button>
      {open && <AiAccessDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** Explicit, session-only AI access with the consent text from spec §54. */
export function AiAccessDialog({ onClose }: { onClose: () => void }) {
  const access = useApp((s) => s.aiAccess);
  const game = useApp((s) => s.game);
  const [mode, setMode] = useState<AiAccess["mode"]>(access.mode);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = async () => {
    const body: AiAccess =
      mode === "current_game" && game ? { mode, gameId: game.id } : mode === "library" ? { mode } : { mode: "off" };
    try {
      await api.post("/api/ai/access", body);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-labelledby="ai-title" ref={dialog}>
        <h2 id="ai-title">AI access</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          AI access allows your connected AI client to read the selected chess data. ChessAnalyser itself does not send your
          games to an AI provider unless the AI client requests them.
        </p>
        <div className="radio-list" role="radiogroup">
          <label className="radio-option">
            <input type="radio" name="ai" checked={mode === "off"} onChange={() => setMode("off")} />
            <span>
              <strong>Off</strong>
              <br />
              <span className="muted">AI clients cannot read any games.</span>
            </span>
          </label>
          <label className="radio-option" aria-disabled={!game}>
            <input type="radio" name="ai" disabled={!game} checked={mode === "current_game"} onChange={() => setMode("current_game")} />
            <span>
              <strong>Current game</strong>
              <br />
              <span className="muted">{game ? "Only this game. Opening another game turns access off." : "Open a game first."}</span>
            </span>
          </label>
          <label className="radio-option">
            <input type="radio" name="ai" checked={mode === "library"} onChange={() => setMode("library")} />
            <span>
              <strong>Entire library</strong>
              <br />
              <span className="muted">Any imported game, until ChessAnalyser restarts.</span>
            </span>
          </label>
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Access resets to Off whenever ChessAnalyser restarts. Connect a client with <code>npm run mcp</code>.
        </p>
        {error && <p className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={apply} data-testid="ai-apply">
            {mode === "off" ? "Turn off" : "Allow access"}
          </button>
        </div>
      </div>
    </div>
  );
}
