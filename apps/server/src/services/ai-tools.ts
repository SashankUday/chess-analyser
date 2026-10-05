// AI tool handlers behind the MCP adapter (spec §45–51). No chess logic of its own: everything goes
// through the same services the web UI uses. Writes only touch ephemeral UI session state.
import { checkedKingSquare, legalMoveCount, material, sideToMove, terminalState } from "@chessanalyser/chess-core";
import type { ChessDb } from "@chessanalyser/database";
import {
  AiAnalysePositionInput,
  AiCandidateInput,
  AiDrawArrowsInput,
  AiEmptyInput,
  AiGetGameInput,
  AiHighlightSquaresInput,
  AiListGamesInput,
  AiPositionInput,
  AiShowVariationInput,
  CLASSIFICATION_LABELS,
  STALE_SESSION,
  formatEvaluation,
  moveNumberLabel,
  type EngineAnalysis,
  type EngineLine,
  type Game,
  type VariationMove,
} from "@chessanalyser/shared";
import { z } from "zod";
import { HttpError, fromZod } from "../errors";
import type { Logger } from "../logger";
import type { AiPermissionService } from "./ai-permission";
import type { AnalysisService } from "./analysis";
import type { GameService } from "./games";
import type { UiSessionService, UiSessionState } from "./ui-sessions";
import type { VariationService } from "./variations";

const stale = (message: string) => new HttpError(409, STALE_SESSION, message);

type Handler = (input: unknown) => Promise<unknown> | unknown;

export class AiToolService {
  private handlers: Record<string, { schema: z.ZodType; run: Handler }>;

  constructor(
    private readonly db: ChessDb,
    private readonly games: GameService,
    private readonly analysis: AnalysisService,
    private readonly variations: VariationService,
    private readonly ui: UiSessionService,
    private readonly permission: AiPermissionService,
    private readonly log: Logger,
  ) {
    const h = <S extends z.ZodType>(schema: S, run: (input: z.infer<S>) => unknown) => ({ schema, run: run as Handler });
    this.handlers = {
      get_active_game: h(AiEmptyInput, () => this.getActiveGame()),
      list_games: h(AiListGamesInput, (i) => this.listGames(i)),
      get_game: h(AiGetGameInput, (i) => this.getGame(i.game_id)),
      get_position: h(AiPositionInput, (i) => this.getPosition(i.game_id, i.ply)),
      get_move_review: h(AiPositionInput, (i) => this.getMoveReview(i.game_id, i.ply)),
      analyse_position: h(AiAnalysePositionInput, (i) => this.analysePosition(i)),
      analyse_candidate: h(AiCandidateInput, (i) => this.analyseCandidate(i)),
      show_position: h(AiPositionInput, (i) => this.showPosition(i.game_id, i.ply)),
      show_variation: h(AiShowVariationInput, (i) => this.showVariation(i.line_id)),
      highlight_squares: h(AiHighlightSquaresInput, (i) => this.highlight(i)),
      draw_arrows: h(AiDrawArrowsInput, (i) => this.arrows(i)),
      clear_overlays: h(AiEmptyInput, () => this.clearOverlays()),
    };
  }

  get toolNames(): string[] {
    return Object.keys(this.handlers);
  }

  /** Safe metadata, available even when AI access is OFF. */
  status() {
    return { running: true, app: "ChessAnalyser", ai_access: this.permission.access.mode };
  }

  async call(tool: string, rawInput: unknown): Promise<unknown> {
    const handler = this.handlers[tool];
    if (!handler) throw new HttpError(404, "UNKNOWN_TOOL", `Unknown tool ${tool}.`);
    const parsed = handler.schema.safeParse(rawInput ?? {});
    const input = parsed.success ? (parsed.data as Record<string, unknown>) : {};
    const audit = {
      tool,
      gameId: typeof input.game_id === "string" ? input.game_id : null,
      ply: typeof input.ply === "number" ? input.ply : null,
      lineId: typeof input.line_id === "string" ? input.line_id : null,
    };
    try {
      if (!parsed.success) throw fromZod(parsed.error);
      const result = await handler.run(parsed.data);
      this.db.addAudit({ ...audit, result: "OK" });
      this.log.info({ component: "mcp", ...audit }, `${tool} OK`);
      return result;
    } catch (err) {
      const code = err instanceof HttpError ? err.code : "ERROR";
      this.db.addAudit({ ...audit, result: code });
      this.log.info({ component: "mcp", ...audit, result: code }, `${tool} ${code}`);
      throw err;
    }
  }

  // ---- reads ----

  private getActiveGame() {
    this.permission.require();
    const session = this.ui.active();
    if (!session?.gameId) return { active: false, message: "No game is open in ChessAnalyser.", scope: this.permission.access.mode };
    this.permission.require(session.gameId);
    const game = this.games.get(session.gameId);
    return { active: true, ...gameSummary(game), current_ply: session.ply ?? 0, scope: this.permission.access.mode };
  }

  private listGames(input: z.infer<typeof AiListGamesInput>) {
    this.permission.require();
    if (!this.permission.allowsLibrary()) {
      throw new HttpError(403, "AI_ACCESS_DENIED", "Listing games requires ENTIRE LIBRARY access.");
    }
    return {
      games: this.games.list({ filter: input.filter, limit: input.limit, offset: 0 }).map((g) => ({
        ...gameSummary(g),
        analysed: g.analysed,
      })),
    };
  }

  private getGame(gameId: string) {
    this.permission.require(gameId);
    const game = this.games.get(gameId);
    const moves = this.db.getMoves(gameId);
    const review = this.analysis.getReview(gameId);
    const byPly = new Map(review.reviews.map((r) => [r.ply, r]));
    return {
      ...gameSummary(game),
      moves: moves.map((m) => ({
        ply: m.ply,
        move: `${moveNumberLabel(m.ply)} ${m.san}`,
        classification: byPly.get(m.ply) ? CLASSIFICATION_LABELS[byPly.get(m.ply)!.classification] : null,
      })),
      review: { analysed: review.reviews.length > 0, complete: review.complete, summary: review.summary },
    };
  }

  private getPosition(gameId: string, ply: number) {
    this.permission.require(gameId);
    this.games.get(gameId);
    const fen = this.games.positionFen(gameId, ply);
    const last = ply > 0 ? this.db.getMove(gameId, ply) : null;
    const m = material(fen);
    const stored = this.analysis.getReview(gameId).positions[ply];
    const terminal = terminalState(fen);
    return {
      game_id: gameId,
      ply,
      fen,
      side_to_move: sideToMove(fen),
      last_move: last ? { ply, san: last.san, uci: last.uci, label: `${moveNumberLabel(ply)} ${last.san}` } : null,
      in_check: checkedKingSquare(fen) !== null,
      terminal: terminal ?? null,
      legal_move_count: legalMoveCount(fen),
      material: { white: m.white, black: m.black, balance_for_white: m.balance },
      stored_evaluation: stored
        ? { engine: stored.engine, evaluation: formatEvaluation(stored.evaluation), wdl: stored.wdl ?? null }
        : null,
    };
  }

  private getMoveReview(gameId: string, ply: number) {
    this.permission.require(gameId);
    this.games.get(gameId);
    if (ply < 1) throw new HttpError(400, "BAD_PLY", "Ply 0 is the starting position; moves start at ply 1.");
    const review = this.db.getReview(gameId, ply);
    if (!review) {
      return {
        reviewed: false,
        message: "This move has not been reviewed yet. The user can click Analyse game, or use analyse_position.",
      };
    }
    let bestLine: ReturnType<typeof lineView> | null = null;
    if (review.bestLineId) {
      try {
        const line = this.variations.line(review.bestLineId);
        this.issue(line, gameId, ply - 1, []);
        bestLine = lineView(line);
      } catch {
        bestLine = null;
      }
    }
    const v2 = review.v2;
    // The engine line that demonstrates the explanation (e.g. how material is lost) is showable too.
    let consequenceLine: ReturnType<typeof lineView> | null = null;
    if (v2?.explanation.lineId && v2.explanation.lineId !== review.bestLineId) {
      try {
        const line = this.variations.line(v2.explanation.lineId);
        this.issue(line, gameId, ply - 1, []);
        consequenceLine = lineView(line);
      } catch {
        consequenceLine = null;
      }
    }
    return {
      reviewed: true,
      ply,
      move: `${moveNumberLabel(ply)} ${review.playedMoveSan}`,
      mover: review.mover,
      classification: CLASSIFICATION_LABELS[review.classification],
      badges: review.badges,
      evaluation_before: formatEvaluation(review.evaluationBefore),
      evaluation_after: formatEvaluation(review.evaluationAfter),
      ...(v2
        ? {
            // Mover-relative, measured from the same pre-move position.
            played_rank: v2.metrics.playedRank,
            cp_loss: v2.metrics.cpLoss,
            win_percent_best: v2.metrics.bestWinPercent,
            win_percent_played: v2.metrics.playedWinPercent,
            win_percent_loss: v2.metrics.winPercentLoss,
            result_before: v2.metrics.resultClassBefore,
            result_after: v2.metrics.resultClassAfter,
            criticality: v2.metrics.criticality,
            top_moves: v2.metrics.rootMoves.map((m) => ({ move: m.san, rank: m.rank, cp: m.cp, win_percent: m.winPercent })),
            threats_before: v2.insightsBefore?.threats.map((t) => ({ by: t.side, move: t.san, kind: t.kind, description: t.description })) ?? [],
            threats_after: v2.insightsAfter?.threats.map((t) => ({ by: t.side, move: t.san, kind: t.kind, description: t.description })) ?? [],
            explanation_detail: {
              headline: v2.explanation.headline,
              position_change: v2.explanation.positionChange ?? null,
              threat_before: v2.explanation.threatBefore ?? null,
              consequence: v2.explanation.consequence ?? null,
              best_move_reason: v2.explanation.bestMoveReason ?? null,
              confidence: v2.explanation.confidence,
            },
            consequence_line: consequenceLine,
          }
        : {
            expected_score_best: review.expectedScoreBest,
            expected_score_played: review.expectedScorePlayed,
            expected_score_loss: review.expectedScoreLoss,
          }),
      best_move: review.bestMoveSan,
      best_line: bestLine,
      tags: review.tags,
      explanation: review.explanation,
      engine: `${review.engine} ${review.engineVersion}`,
      review_algorithm_version: review.algorithmVersion,
      verified_by_deeper_search: review.verified,
      reduced_review: review.reduced,
    };
  }

  private async analysePosition(input: z.infer<typeof AiAnalysePositionInput>) {
    this.permission.require(input.game_id);
    const analysis = await this.analysis.analysePosition(input.game_id, input.ply, {
      preset: input.preset,
      multipv: input.multipv,
      kind: "CANDIDATE",
    });
    // Access may have been revoked while the engine was searching.
    this.permission.require(input.game_id);
    for (const l of analysis.lines) this.issue(l, input.game_id, input.ply, []);
    return { game_id: input.game_id, ply: input.ply, ...analysisView(analysis) };
  }

  private async analyseCandidate(input: z.infer<typeof AiCandidateInput>) {
    this.permission.require(input.game_id);
    const { move, analysis } = await this.analysis.analyseCandidate(input.game_id, input.ply, input.move);
    this.permission.require(input.game_id);
    for (const l of analysis.lines) this.issue(l, input.game_id, input.ply, [move]);
    return {
      game_id: input.game_id,
      ply: input.ply,
      candidate: { san: move.san, uci: move.uci },
      position_after_candidate: analysisView(analysis),
      note: "Lines start with the opponent's best reply to the candidate move. Pass a line_id to show_variation to display it.",
    };
  }

  // ---- safe, ephemeral UI writes ----

  private requireSession(): UiSessionState {
    const s = this.ui.active();
    if (!s) throw stale("ChessAnalyser has no open window to update.");
    return s;
  }

  private showPosition(gameId: string, ply: number) {
    this.permission.require(gameId);
    this.games.positionFen(gameId, ply);
    const session = this.requireSession();
    if (this.permission.access.mode === "current_game" && session.gameId !== gameId) {
      throw stale("The authorised game is no longer open.");
    }
    this.ui.update(session.id, { boardMode: { type: "game", gameId, ply } });
    this.ui.send(session.id, { type: "ui.position.show", gameId, ply });
    return { shown: true, game_id: gameId, ply };
  }

  private showVariation(lineId: string) {
    const issued = this.variations.issuedLine(lineId);
    if (!issued) {
      throw new HttpError(404, "UNKNOWN_LINE", "That line_id was not produced by ChessAnalyser. Use an id returned by analyse_position, analyse_candidate or get_move_review.");
    }
    this.permission.require(issued.gameId);
    const session = this.requireSession();
    if (issued.epoch !== this.permission.epoch || issued.sessionId !== session.id || session.gameId !== issued.gameId) {
      throw stale("That line belongs to an earlier session or a game that is no longer open. Analyse the position again.");
    }
    this.ui.update(session.id, { boardMode: { type: "engineVariation", lineId, index: issued.prefix.length + 1 } });
    this.ui.send(session.id, {
      type: "ui.variation.show",
      gameId: issued.gameId,
      startingPly: issued.startingPly,
      line: issued.line,
      prefix: issued.prefix,
    });
    return { shown: true, line_id: lineId, moves: [...issued.prefix, ...issued.line.moves].map((m) => m.san) };
  }

  private overlaySession(): UiSessionState {
    const session = this.requireSession();
    if (!session.gameId) throw stale("No game is open in ChessAnalyser.");
    this.permission.require(session.gameId);
    return session;
  }

  private highlight(input: z.infer<typeof AiHighlightSquaresInput>) {
    const session = this.overlaySession();
    const squares = input.squares.map((square) => ({ square, role: input.role ?? ("primary" as const) }));
    this.ui.update(session.id, { overlays: { ...session.overlays, squares } });
    this.ui.send(session.id, { type: "ui.squares.highlight", squares });
    return { highlighted: input.squares };
  }

  private arrows(input: z.infer<typeof AiDrawArrowsInput>) {
    const session = this.overlaySession();
    const arrows = input.arrows.map((a) => ({ from: a.from, to: a.to, role: a.role ?? ("primary" as const) }));
    this.ui.update(session.id, { overlays: { ...session.overlays, arrows } });
    this.ui.send(session.id, { type: "ui.arrows.draw", arrows });
    return { drawn: arrows.length };
  }

  private clearOverlays() {
    const session = this.overlaySession();
    this.ui.update(session.id, { overlays: { arrows: [], squares: [] } });
    this.ui.send(session.id, { type: "ui.overlays.clear" });
    return { cleared: true };
  }

  private issue(line: EngineLine, gameId: string, startingPly: number, prefix: VariationMove[]): void {
    this.variations.issue(line, {
      gameId,
      startingPly,
      prefix,
      epoch: this.permission.epoch,
      sessionId: this.ui.active()?.id ?? null,
    });
  }
}

function gameSummary(game: Omit<Game, "pgn">) {
  return {
    game_id: game.id,
    white: game.white,
    black: game.black,
    result: game.result,
    played_at: game.playedAt,
    time_class: game.timeClass,
    time_control: game.timeControl,
    opening: game.eco || game.openingName ? { eco: game.eco, name: game.openingName } : null,
    plies: game.plyCount,
    supported: game.supported,
  };
}

function lineView(line: EngineLine) {
  return {
    line_id: line.id,
    rank: line.rank,
    evaluation: formatEvaluation(line.evaluation),
    moves: line.moves.map((m) => m.san),
  };
}

function analysisView(a: EngineAnalysis) {
  return {
    fen: a.fen,
    engine: `${a.engine} ${a.engineVersion}`,
    evaluation: formatEvaluation(a.evaluation),
    wdl_for_white: a.wdl ?? null,
    depth: a.depth ?? null,
    lines: a.lines.map(lineView),
  };
}
