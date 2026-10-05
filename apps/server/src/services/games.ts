import { START_FEN } from "@chessanalyser/chess-core";
import type { ChessDb } from "@chessanalyser/database";
import type { Game, GameMove, GamesQueryT } from "@chessanalyser/shared";
import { badRequest, notFound } from "../errors";

/** Read access to the immutable imported games (spec §2.4). Nothing here modifies a game. */
export class GameService {
  constructor(private readonly db: ChessDb) {}

  list(query: GamesQueryT) {
    return this.db.listGames(query);
  }

  get(gameId: string): Game {
    const g = this.db.getGame(gameId);
    if (!g) throw notFound("Game");
    return g;
  }

  moves(gameId: string): GameMove[] {
    this.get(gameId);
    return this.db.getMoves(gameId);
  }

  /** Every position of the game: index = ply (0 = starting position). */
  positions(gameId: string): string[] {
    const game = this.get(gameId);
    const moves = this.db.getMoves(gameId);
    const start = moves[0]?.fenBefore ?? (this.db.getStartFen(gameId) || START_FEN);
    if (!game.supported) return [start];
    return [start, ...moves.map((m) => m.fenAfter)];
  }

  positionFen(gameId: string, ply: number): string {
    const positions = this.positions(gameId);
    const fen = positions[ply];
    if (fen === undefined) throw badRequest(`This game has no position at ply ${ply} (it has ${positions.length - 1} plies).`);
    return fen;
  }

  requireSupported(game: Game): void {
    if (!game.supported) throw badRequest(`Variant not supported in V1 (${game.variant}).`);
  }
}
