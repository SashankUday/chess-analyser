import { PALETTES, type Palette } from "@chessanalyser/shared";
import { useApp } from "../store";
import { AiAccessPill } from "./AiAccessDialog";

export function Header() {
  const settings = useApp((s) => s.settings);
  const setPalette = useApp((s) => s.setPalette);
  return (
    <header className="app-header">
      <a className="brand" href="#/">
        <span className="brand-mark" aria-hidden>
          ♞
        </span>
        <span className="brand-text">ChessAnalyser</span>
      </a>
      <span className="header-spacer" />
      <div className="header-controls">
        <label className="visually-hidden" htmlFor="palette">
          Colour palette
        </label>
        <select
          id="palette"
          className="select"
          value={settings?.palette ?? "navy"}
          onChange={(e) => void setPalette(e.target.value as Palette)}
          data-testid="palette"
        >
          {PALETTES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <AiAccessPill />
        <a className="btn btn-ghost btn-icon" href="#/settings" aria-label="Settings" title="Settings">
          ⚙
        </a>
      </div>
    </header>
  );
}
