import crypto from "node:crypto";
import { parseMove } from "@chessanalyser/chess-core";
import type { ChessDb } from "@chessanalyser/database";
import type { EngineLine, Variation, VariationMove } from "@chessanalyser/shared";
import { HttpError, notFound } from "../errors";
import type { GameService } from "./games";

interface TempVariation extends Variation {
  sessionId: string | null;
}

/** Lines handed to an AI client, valid only for the permission epoch and UI session they were issued in. */
interface IssuedLine {
  line: EngineLine;
  gameId: string;
  startingPly: number;
  prefix: VariationMove[];
  epoch: number;
  sessionId: string | null;
}

/**
 * Variations never alter the game (spec §43). User variations are temporary server-side state until
 * the user explicitly saves one; AI-shown engine lines are never persisted.
 */
export class VariationService {
  private temp = new Map<string, TempVariation>();
  private issued = new Map<string, IssuedLine>();

  constructor(
    private readonly db: ChessDb,
    private readonly games: GameService,
  ) {}

  create(input: { gameId: string; startingPly: number; move: string; sessionId?: string }): Variation {
    this.games.requireSupported(this.games.get(input.gameId));
    const fen = this.games.positionFen(input.gameId, input.startingPly);
    const move = this.validate(fen, input.move);
    const v: TempVariation = {
      id: crypto.randomUUID(),
      gameId: input.gameId,
      startingPly: input.startingPly,
      type: "user",
      createdBy: "user",
      moves: [move],
      saved: false,
      sessionId: input.sessionId ?? null,
    };
    this.temp.set(v.id, v);
    return publicView(v);
  }

  /** Keep the first `atIndex` moves, then append `move` (a move from mid-line replaces the rest). */
  extend(id: string, atIndex: number, moveText: string): Variation {
    const v = this.temp.get(id);
    if (!v) throw notFound("Variation");
    if (atIndex > v.moves.length) throw new HttpError(400, "BAD_INDEX", "That position is not part of this variation.");
    const fen = atIndex === 0 ? this.games.positionFen(v.gameId, v.startingPly) : v.moves[atIndex - 1]!.fenAfter;
    const move = this.validate(fen, moveText);
    v.moves = [...v.moves.slice(0, atIndex), move];
    v.saved = false;
    return publicView(v);
  }

  get(id: string): Variation {
    const v = this.temp.get(id);
    if (!v) throw notFound("Variation");
    return publicView(v);
  }

  /** Explicit user action only. */
  save(id: string): Variation {
    const v = this.temp.get(id);
    if (!v) throw notFound("Variation");
    if (!v.saved) {
      this.db.saveVariation({ ...v, id: crypto.randomUUID() });
      v.saved = true;
    }
    return publicView(v);
  }

  discard(id: string): void {
    this.temp.delete(id);
  }

  discardSession(sessionId: string): void {
    for (const [id, v] of this.temp) if (v.sessionId === sessionId) this.temp.delete(id);
  }

  listSaved(gameId: string): Variation[] {
    return this.db.listVariations(gameId);
  }

  // ---- engine lines issued to AI clients ----

  issue(line: EngineLine, ctx: Omit<IssuedLine, "line">): void {
    this.issued.set(line.id, { line, ...ctx });
  }

  issuedLine(lineId: string): IssuedLine | null {
    return this.issued.get(lineId) ?? null;
  }

  /** Engine line for the UI's own engine-variation mode (best lines from the review panel). */
  line(lineId: string): EngineLine {
    const issued = this.issued.get(lineId);
    if (issued) return issued.line;
    const stored = this.db.getLine(lineId);
    if (!stored) throw notFound("Engine line");
    return stored.line;
  }

  private validate(fen: string, text: string): VariationMove {
    const parsed = parseMove(fen, text);
    if (!parsed.ok) throw new HttpError(422, parsed.error === "ambiguous" ? "AMBIGUOUS_MOVE" : "ILLEGAL_MOVE", parsed.message);
    return { san: parsed.san, uci: parsed.uci, fenAfter: parsed.fenAfter };
  }
}

function publicView(v: TempVariation): Variation {
  const { sessionId: _s, ...rest } = v;
  return { ...rest, moves: [...rest.moves] };
}
