// WebSocket messages between the backend and the browser (spec §41).
import type {
  AiAccess,
  Arrow,
  EngineLine,
  EngineStatus,
  GameId,
  JobInfo,
  PositionEvaluation,
  SquareHighlight,
} from "./types";

export type ServerEvent =
  | { type: "session.ready"; sessionId: string }
  | { type: "engine.status"; status: EngineStatus }
  | { type: "analysis.started"; job: JobInfo }
  | { type: "analysis.progress"; job: JobInfo; position?: PositionEvaluation }
  | { type: "analysis.completed"; job: JobInfo }
  | { type: "analysis.failed"; job: JobInfo }
  | { type: "game.imported"; gameId: GameId }
  | { type: "sync.progress"; profileId: string; message: string }
  | { type: "sync.completed"; profileId: string; imported: number; failed: number; error?: string }
  | { type: "ai.access"; access: AiAccess }
  | { type: "ui.position.show"; gameId: GameId; ply: number }
  | {
      type: "ui.variation.show";
      gameId: GameId;
      startingPly: number;
      line: EngineLine;
      /** Moves before the engine line (a candidate move the AI asked about). */
      prefix: EngineLine["moves"];
    }
  | { type: "ui.squares.highlight"; squares: SquareHighlight[] }
  | { type: "ui.arrows.draw"; arrows: Arrow[] }
  | { type: "ui.overlays.clear" };

export type ClientEvent = { type: "ui.state"; gameId: GameId | null; ply: number | null };

/** WebSocket subprotocols: the first names the protocol, the second carries the token. */
export const WS_PROTOCOL = "chessanalyser.v1";
export const WS_TOKEN_PREFIX = "token.";
