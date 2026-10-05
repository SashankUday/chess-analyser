import { useEffect, useState } from "react";
import { PALETTES, type AnalysisPresetName, type EngineStatus, type Profile, type Settings } from "@chessanalyser/shared";
import { api, ApiError } from "../api";
import { AiAccessDialog } from "../components/AiAccessDialog";
import { useApp } from "../store";

interface EngineInfo {
  status: EngineStatus;
  identity: { name: string; version: string; path: string; network?: string } | null;
  threads: number;
  paused: boolean;
  dataDir: string;
  database: string;
}

interface AuditEntry {
  id: number;
  timestamp: string;
  tool: string;
  gameId: string | null;
  ply: number | null;
  lineId: string | null;
  result: string;
}

export function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const engineStatus = useApp((s) => s.engine);
  const access = useApp((s) => s.aiAccess);
  const setPalette = useApp((s) => s.setPalette);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [path, setPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    void api.get<EngineInfo>("/api/engine").then(setEngine);
    void api.get<Profile[]>("/api/profiles").then(setProfiles);
    void api.get<AuditEntry[]>("/api/ai/audit").then(setAudit);
  }, [engineStatus, access]);
  useEffect(() => setPath(settings?.stockfishPath ?? ""), [settings?.stockfishPath]);

  const patch = async (body: Partial<Settings>) => {
    try {
      useApp.setState({ settings: await api.patch<Settings>("/api/settings", body) });
      setMessage("Saved.");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : String(err));
    }
  };

  if (!settings) return <div className="page muted">Loading…</div>;
  const profile = profiles.at(-1);

  return (
    <div className="page">
      <div className="settings">
        <section className="card">
          <h2>Appearance</h2>
          <div className="palette-options" role="radiogroup" aria-label="Palette">
            {PALETTES.map((p) => (
              <button
                key={p.id}
                className="palette-swatch"
                role="radio"
                aria-checked={settings.palette === p.id}
                onClick={() => void setPalette(p.id)}
                data-palette={p.id}
              >
                <span className="swatch" aria-hidden>
                  <span style={{ background: "var(--board-light)" }} />
                  <span style={{ background: "var(--board-dark)" }} />
                </span>
                {p.label}
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Analysis</h2>
          <dl>
            <dt>Default mode</dt>
            <dd>
              <select
                className="select"
                value={settings.defaultPreset}
                onChange={(e) => void patch({ defaultPreset: e.target.value as AnalysisPresetName })}
              >
                <option value="quick">Quick — 50,000 nodes</option>
                <option value="standard">Standard — 200,000 nodes</option>
                <option value="deep">Deep — 1,000,000 nodes, 3 lines</option>
              </select>
            </dd>
            <dt>Engine</dt>
            <dd>
              {engine?.identity ? engine.identity.name : engineStatus.state}
              {engineStatus.state === "ready" && engineStatus.fallback && " (fallback)"}
              {engine?.identity?.network && <div className="muted">Network {engine.identity.network}</div>}
            </dd>
            <dt>Threads</dt>
            <dd>
              <select
                className="select"
                value={String(settings.threads)}
                onChange={(e) => void patch({ threads: e.target.value === "auto" ? "auto" : Number(e.target.value) })}
              >
                <option value="auto">Automatic ({engine?.threads ?? "…"})</option>
                {[1, 2, 4, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </dd>
            <dt>Hash</dt>
            <dd>
              <select className="select" value={settings.hashMb} onChange={(e) => void patch({ hashMb: Number(e.target.value) })}>
                {[64, 128, 256, 512, 1024].map((n) => (
                  <option key={n} value={n}>
                    {n} MB
                  </option>
                ))}
              </select>
            </dd>
          </dl>
        </section>

        <section className="card">
          <h2>Chess.com</h2>
          <dl>
            <dt>Username</dt>
            <dd>{profile?.username ?? settings.chesscomUsername ?? "—"}</dd>
            <dt>Last sync</dt>
            <dd>{profile?.lastSyncAt ? new Date(profile.lastSyncAt).toLocaleString() : "never"}</dd>
            <dt />
            <dd>
              <button className="btn" disabled={!profile} onClick={() => profile && void api.post(`/api/chesscom/${profile.id}/sync`, {})}>
                Sync now
              </button>
            </dd>
          </dl>
        </section>

        <section className="card">
          <h2>AI access</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Currently <strong>{access.mode === "off" ? "OFF" : access.mode === "current_game" ? "CURRENT GAME" : "ENTIRE LIBRARY"}</strong>.
            Access resets to Off when ChessAnalyser restarts.
          </p>
          <button className="btn" onClick={() => setAiOpen(true)}>
            Change AI access
          </button>
          {aiOpen && <AiAccessDialog onClose={() => setAiOpen(false)} />}
          <h3 style={{ fontSize: 13, margin: "16px 0 6px" }}>Recent AI activity</h3>
          {audit.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No AI tool calls yet.</p>
          ) : (
            <ul className="audit-list">
              {audit.map((a) => (
                <li key={a.id}>
                  {new Date(a.timestamp).toLocaleTimeString()} {a.tool}
                  {a.gameId && ` game=${a.gameId.slice(0, 8)}`}
                  {a.ply !== null && ` ply=${a.ply}`}
                  {a.lineId && ` line=${a.lineId.slice(0, 8)}`} {a.result}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Advanced</h2>
          <dl>
            <dt>Stockfish path</dt>
            <dd>
              <div className="form-row" style={{ marginTop: 0 }}>
                <input
                  className="input"
                  value={path}
                  placeholder="Automatic (managed Stockfish 19)"
                  onChange={(e) => setPath(e.target.value)}
                  spellCheck={false}
                />
                <button className="btn" onClick={() => void patch({ stockfishPath: path.trim() || null })}>
                  Save
                </button>
              </div>
              {engine?.identity && <div className="muted" style={{ marginTop: 4 }}>In use: {engine.identity.path}</div>}
            </dd>
            <dt>Data folder</dt>
            <dd className="muted">{engine?.dataDir}</dd>
            <dt>Database</dt>
            <dd className="muted">{engine?.database}</dd>
            <dt>Engine</dt>
            <dd className="analyse-row">
              <button className="btn" onClick={() => void api.post("/api/engine/reinstall").then(() => setMessage("Reinstalling Stockfish…"))}>
                Reinstall engine
              </button>
              <button
                className="btn"
                onClick={() =>
                  void api.post<{ removed: number }>("/api/engine/clear-cache").then((r) => setMessage(`Cleared ${r.removed} cached analyses.`))
                }
              >
                Clear engine cache
              </button>
            </dd>
          </dl>
          {engineStatus.state === "unavailable" && <p className="error-text">{engineStatus.error}</p>}
          {message && <p className="muted" aria-live="polite">{message}</p>}
        </section>
      </div>
    </div>
  );
}
