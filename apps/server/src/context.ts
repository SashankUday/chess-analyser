import type { ChessDb } from "@chessanalyser/database";
import type { ChessComClient } from "@chessanalyser/chesscom";
import type { Logger } from "./logger";
import type { SecurityConfig } from "./security";
import { AiPermissionService } from "./services/ai-permission";
import { AiToolService } from "./services/ai-tools";
import { AnalysisService } from "./services/analysis";
import { EngineService } from "./services/engine";
import { GameService } from "./services/games";
import { ImportService } from "./services/import";
import { UiSessionService } from "./services/ui-sessions";
import { VariationService } from "./services/variations";

/** All backend services (spec §69). The web UI and MCP reach them only through the HTTP API. */
export interface AppContext {
  db: ChessDb;
  log: Logger;
  security: SecurityConfig;
  ui: UiSessionService;
  permission: AiPermissionService;
  games: GameService;
  engine: EngineService;
  imports: ImportService;
  analysis: AnalysisService;
  variations: VariationService;
  ai: AiToolService;
}

export function createContext(args: {
  db: ChessDb;
  log: Logger;
  security: SecurityConfig;
  chesscom?: ChessComClient;
}): AppContext {
  const { db, log, security } = args;
  const ui = new UiSessionService();
  const permission = new AiPermissionService();
  const games = new GameService(db);
  const engine = new EngineService(db, log);
  const imports = new ImportService(db, ui, log, args.chesscom);
  const analysis = new AnalysisService(db, games, engine, ui, log);
  const variations = new VariationService(db, games);
  const ai = new AiToolService(db, games, analysis, variations, ui, permission, log);

  // CURRENT GAME access is bound to one game; switching games revokes it (spec §47).
  ui.onGameChange((session) => {
    if (ui.active()?.id === session.id) permission.gameChanged(session.gameId);
  });
  ui.onClose((sessionId) => variations.discardSession(sessionId));
  permission.onChange((access) => {
    ui.broadcast({ type: "ai.access", access });
    log.info({ component: "ai", mode: access.mode }, "AI access changed");
  });
  engine.manager.onStatus((status) => ui.broadcast({ type: "engine.status", status }));

  return { db, log, security, ui, permission, games, engine, imports, analysis, variations, ai };
}
