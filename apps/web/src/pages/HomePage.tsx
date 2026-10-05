import { useEffect, useState, type FormEvent } from "react";
import type { GameFilter, GameSummary, Profile } from "@chessanalyser/shared";
import { api, ApiError } from "../api";
import { EngineBanner } from "../components/EngineBanner";
import { useApp } from "../store";

const FILTERS: { id: GameFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "rapid", label: "Rapid" },
  { id: "blitz", label: "Blitz" },
  { id: "bullet", label: "Bullet" },
  { id: "daily", label: "Daily" },
  { id: "wins", label: "Wins" },
  { id: "draws", label: "Draws" },
  { id: "losses", label: "Losses" },
  { id: "analysed", label: "Analysed" },
  { id: "not_analysed", label: "Not analysed" },
];

export function HomePage() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .get<Profile[]>("/api/profiles")
      .then(setProfiles)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  const version = useApp((s) => s.libraryVersion);
  useEffect(() => {
    void load();
  }, [version]);

  if (error) return <div className="page"><div className="banner banner-error">{error}</div></div>;
  if (!profiles) return <div className="page muted">Loading…</div>;
  if (profiles.length === 0) return <Onboarding onAdded={load} />;
  return <Library profile={profiles[profiles.length - 1]!} />;
}

function Onboarding({ onAdded }: { onAdded: () => Promise<void> | void }) {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const profile = await api.post<Profile>("/api/chesscom/profiles", { username: username.trim() });
      await api.post(`/api/chesscom/${profile.id}/sync`, {});
      await onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <EngineBanner />
      <form className="card onboarding" onSubmit={submit}>
        <h1>Welcome to ChessAnalyser</h1>
        <p className="muted" style={{ margin: 0 }}>
          Free, local game review powered by Stockfish. Enter your Chess.com username to import your public games — no login
          needed.
        </p>
        <div className="form-row">
          <label className="visually-hidden" htmlFor="username">
            Chess.com username
          </label>
          <input
            id="username"
            className="input"
            placeholder="Chess.com username"
            autoComplete="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            data-testid="username"
          />
          <button className="btn btn-primary" disabled={busy || username.trim().length < 2} data-testid="import">
            {busy ? "Checking…" : "Import games"}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </form>
    </div>
  );
}

function Library({ profile }: { profile: Profile }) {
  const [filter, setFilter] = useState<GameFilter>("all");
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const syncing = useApp((s) => s.syncing);
  const syncMessage = useApp((s) => s.syncMessage);
  const version = useApp((s) => s.libraryVersion);

  useEffect(() => {
    let cancelled = false;
    api
      .get<GameSummary[]>(`/api/games?profileId=${profile.id}&filter=${filter}&limit=200`)
      .then((g) => !cancelled && setGames(g))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [profile.id, filter, version]);

  const sync = async () => {
    useApp.setState({ syncing: true, syncMessage: "Contacting Chess.com…" });
    try {
      await api.post(`/api/chesscom/${profile.id}/sync`, {});
    } catch (err) {
      useApp.setState({ syncing: false, syncMessage: err instanceof ApiError ? err.message : String(err) });
    }
  };

  return (
    <div className="page">
      <EngineBanner />
      <div className="home-grid">
        <div className="card profile-card">
          <div>
            <div className="profile-name">{profile.username}</div>
            <div className="muted">
              Last synced: {profile.lastSyncAt ? formatWhen(profile.lastSyncAt) : "never"}
              {syncMessage && <> · {syncMessage}</>}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={sync} disabled={syncing} data-testid="sync">
            {syncing ? "Syncing…" : "Sync Chess.com"}
          </button>
        </div>

        <div className="filters" role="group" aria-label="Filter games">
          {FILTERS.map((f) => (
            <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          {games === null ? (
            <div className="empty-state muted">Loading games…</div>
          ) : games.length === 0 ? (
            <div className="empty-state muted">{filter === "all" ? "No games yet. Sync Chess.com to import them." : "No games match this filter."}</div>
          ) : (
            <table className="games-table">
              <thead>
                <tr>
                  <th>Players</th>
                  <th>Result</th>
                  <th className="hide-sm">Type</th>
                  <th className="hide-sm">Opening</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {games.map((g) => (
                  <GameRow key={g.id} game={g} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function GameRow({ game }: { game: GameSummary }) {
  const you = game.userColour;
  const outcome =
    game.result === "1/2-1/2" ? "Draw" : !you ? null : (game.result === "1-0") === (you === "white") ? "Win" : game.result === "*" ? null : "Loss";
  const name = (side: "white" | "black") => (you === side ? "You" : game[side].username);
  const open = () => (window.location.hash = `#/game/${game.id}`);
  return (
    <tr onClick={open} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open()} data-testid="game-row">
      <td>
        <div className="player">
          <span>
            <span aria-hidden>○</span> {name("white")} <span className="rating">{game.white.rating ?? ""}</span>
          </span>
          <span>
            <span aria-hidden>●</span> {name("black")} <span className="rating">{game.black.rating ?? ""}</span>
          </span>
        </div>
      </td>
      <td>
        <span className="result">{game.result === "1/2-1/2" ? "½-½" : game.result}</span>{" "}
        {outcome && <span className={`badge ${outcome === "Win" ? "badge-win" : outcome === "Loss" ? "badge-loss" : ""}`}>{outcome}</span>}
        {game.analysed && <span className="badge" title="Analysed">✓</span>}
        {!game.supported && <span className="badge">Variant not supported</span>}
      </td>
      <td className="hide-sm" style={{ textTransform: "capitalize" }}>{game.timeClass}</td>
      <td className="hide-sm muted">{game.supported ? [game.eco, game.openingName].filter(Boolean).join(" · ") : game.variant}</td>
      <td className="muted">{new Date(game.playedAt).toLocaleDateString()}</td>
    </tr>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString();
}
