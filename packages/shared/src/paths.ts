import os from "node:os";
import path from "node:path";

/**
 * Per-user application data directory (spec §16). Engines, the database, the session credential and
 * logs live here — never inside the repository. `CHESSANALYSER_DATA_DIR` overrides it (used by tests).
 */
export function appDataDir(): string {
  const override = process.env.CHESSANALYSER_DATA_DIR;
  if (override) return path.resolve(override);
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "ChessAnalyser");
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "ChessAnalyser");
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "ChessAnalyser");
  }
}

export const dataPaths = {
  root: () => appDataDir(),
  database: () => path.join(appDataDir(), "chessanalyser.sqlite"),
  session: () => path.join(appDataDir(), "session.json"),
  engines: () => path.join(appDataDir(), "engines"),
  managedStockfishDir: (version: string) => path.join(appDataDir(), "engines", "stockfish", version),
  sjengWorkDir: () => path.join(appDataDir(), "engines", "sjeng-work"),
  logs: () => path.join(appDataDir(), "logs"),
};
