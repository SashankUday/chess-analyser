import { create } from "zustand";
import {
  CLASSIFICATION_ORDER,
  type AiAccess,
  type Arrow,
  type BoardMode,
  type EngineStatus,
  type Game,
  type GameMove,
  type GameReview,
  type JobInfo,
  type MoveClassification,
  type Palette,
  type PositionEvaluation,
  type ServerEvent,
  type Settings,
  type SquareHighlight,
  type Variation,
  type VariationMove,
} from "@chessanalyser/shared";
import { api } from "./api";

/** An engine line being explored on the board (from the review panel or an AI client). */
export interface ActiveLine {
  lineId: string;
  gameId: string;
  /** The game ply the line branches from. */
  startingPly: number;
  moves: VariationMove[];
  source: "review" | "ai";
}

interface AppState {
  settings: Settings | null;
  engine: EngineStatus;
  aiAccess: AiAccess;
  sessionId: string | null;
  syncMessage: string | null;
  syncing: boolean;
  libraryVersion: number;

  game: Game | null;
  moves: GameMove[];
  review: GameReview | null;
  job: JobInfo | null;
  mode: BoardMode | null;
  line: ActiveLine | null;
  variation: Variation | null;
  aiOverlays: { arrows: Arrow[]; squares: SquareHighlight[] };
  flipped: boolean;
  error: string | null;

  setPalette: (palette: Palette) => Promise<void>;
  loadSettings: () => Promise<void>;
  openGame: (gameId: string) => Promise<void>;
  closeGame: () => void;
  refreshReview: () => Promise<void>;
  goToPly: (ply: number) => void;
  step: (delta: number) => void;
  jump: (where: "start" | "end") => void;
  showLine: (line: ActiveLine, index?: number) => void;
  showVariation: (variation: Variation, index?: number) => void;
  returnToGame: () => void;
  flip: () => void;
  setError: (message: string | null) => void;
  handleEvent: (event: ServerEvent) => void;
}

export const useApp = create<AppState>((set, get) => ({
  settings: null,
  engine: { state: "checking" },
  aiAccess: { mode: "off" },
  sessionId: null,
  syncMessage: null,
  syncing: false,
  libraryVersion: 0,

  game: null,
  moves: [],
  review: null,
  job: null,
  mode: null,
  line: null,
  variation: null,
  aiOverlays: { arrows: [], squares: [] },
  flipped: false,
  error: null,

  loadSettings: async () => {
    const settings = await api.get<Settings>("/api/settings");
    document.documentElement.dataset.palette = settings.palette;
    set({ settings });
  },

  setPalette: async (palette) => {
    document.documentElement.dataset.palette = palette;
    try {
      localStorage.setItem("chessanalyser.palette", palette);
    } catch {
      // storage unavailable
    }
    const settings = await api.patch<Settings>("/api/settings", { palette });
    set({ settings });
  },

  openGame: async (gameId) => {
    set({ game: null, moves: [], review: null, job: null, mode: null, line: null, variation: null, error: null, aiOverlays: { arrows: [], squares: [] } });
    const [game, moves, review] = await Promise.all([
      api.get<Game>(`/api/games/${gameId}`),
      api.get<GameMove[]>(`/api/games/${gameId}/moves`),
      api.get<GameReview>(`/api/games/${gameId}/review`),
    ]);
    set({
      game,
      moves,
      review,
      mode: { type: "game", gameId, ply: 0 },
      flipped: game.userColour === "black",
    });
  },

  closeGame: () => set({ game: null, moves: [], review: null, job: null, mode: null, line: null, variation: null }),

  refreshReview: async () => {
    const game = get().game;
    if (!game) return;
    const review = await api.get<GameReview>(`/api/games/${game.id}/review`);
    if (get().game?.id === game.id) set({ review });
  },

  goToPly: (ply) => {
    const { game, moves } = get();
    if (!game) return;
    const clamped = Math.max(0, Math.min(moves.length, ply));
    set({ mode: { type: "game", gameId: game.id, ply: clamped }, line: null, variation: null });
  },

  step: (delta) => {
    const { mode, line, variation } = get();
    if (!mode) return;
    if (mode.type === "game") {
      get().goToPly(mode.ply + delta);
    } else if (mode.type === "engineVariation" && line) {
      const index = mode.index + delta;
      if (index < 0) return get().goToPly(line.startingPly);
      set({ mode: { ...mode, index: Math.min(line.moves.length, index) } });
    } else if (mode.type === "userVariation" && variation) {
      const index = mode.index + delta;
      if (index < 0) return get().goToPly(variation.startingPly);
      set({ mode: { ...mode, index: Math.min(variation.moves.length, index) } });
    }
  },

  jump: (where) => {
    const { mode, moves, line, variation } = get();
    if (!mode) return;
    if (mode.type === "game") get().goToPly(where === "start" ? 0 : moves.length);
    else if (mode.type === "engineVariation" && line) set({ mode: { ...mode, index: where === "start" ? 0 : line.moves.length } });
    else if (mode.type === "userVariation" && variation)
      set({ mode: { ...mode, index: where === "start" ? 0 : variation.moves.length } });
  },

  showLine: (line, index = 1) =>
    set({ line, variation: null, mode: { type: "engineVariation", lineId: line.lineId, index: Math.min(index, line.moves.length) } }),

  showVariation: (variation, index) =>
    set({
      variation,
      line: null,
      mode: { type: "userVariation", variationId: variation.id, index: index ?? variation.moves.length },
    }),

  returnToGame: () => {
    const { line, variation, mode } = get();
    const base = line?.startingPly ?? variation?.startingPly ?? (mode?.type === "game" ? mode.ply : 0);
    if (variation && !variation.saved) void api.del(`/api/variations/${variation.id}`).catch(() => undefined);
    get().goToPly(base);
  },

  flip: () => set({ flipped: !get().flipped }),
  setError: (error) => set({ error }),

  handleEvent: (event) => {
    const state = get();
    switch (event.type) {
      case "session.ready":
        set({ sessionId: event.sessionId });
        break;
      case "engine.status":
        set({ engine: event.status });
        break;
      case "ai.access":
        set({ aiAccess: event.access });
        if (event.access.mode === "off") set({ aiOverlays: { arrows: [], squares: [] } });
        break;
      case "analysis.started":
      case "analysis.progress":
      case "analysis.completed":
      case "analysis.failed":
        if (event.job.gameId && event.job.gameId === state.game?.id) {
          set({ job: event.job });
          if (event.type === "analysis.progress" && event.position && state.review) {
            const positions = [...state.review.positions];
            positions[event.position.ply] = event.position;
            set({ review: { ...state.review, positions } });
          }
          if (event.type === "analysis.completed") void get().refreshReview();
        }
        if (event.type === "analysis.completed") set({ libraryVersion: state.libraryVersion + 1 });
        break;
      case "game.imported":
        set({ libraryVersion: state.libraryVersion + 1 });
        break;
      case "sync.progress":
        set({ syncMessage: event.message, syncing: true });
        break;
      case "sync.completed":
        set({
          syncing: false,
          syncMessage: event.error
            ? event.error
            : `Imported ${event.imported} new game${event.imported === 1 ? "" : "s"}${event.failed ? `, skipped ${event.failed}` : ""}.`,
          libraryVersion: state.libraryVersion + 1,
        });
        break;
      case "ui.position.show":
        if (state.game?.id === event.gameId) get().goToPly(event.ply);
        else window.location.hash = `#/game/${event.gameId}?ply=${event.ply}`;
        break;
      case "ui.variation.show":
        if (state.game?.id === event.gameId) {
          get().showLine(
            {
              lineId: event.line.id,
              gameId: event.gameId,
              startingPly: event.startingPly,
              moves: [...event.prefix, ...event.line.moves],
              source: "ai",
            },
            event.prefix.length + 1,
          );
        }
        break;
      case "ui.squares.highlight":
        set({ aiOverlays: { ...state.aiOverlays, squares: event.squares } });
        break;
      case "ui.arrows.draw":
        set({ aiOverlays: { ...state.aiOverlays, arrows: event.arrows } });
        break;
      case "ui.overlays.clear":
        set({ aiOverlays: { arrows: [], squares: [] } });
        break;
    }
  },
}));

// ---------- derived view of the board ----------

export interface BoardView {
  fen: string;
  /** UCI of the move that led to this position, if any. */
  lastMoveUci: string | null;
  /** Game ply the current position belongs to or branches from. */
  basePly: number;
  inVariation: boolean;
  /** Classification of the move that led here (game mode only). */
  lastClassification: MoveClassification | null;
  position: PositionEvaluation | null;
}

export function boardView(s: Pick<AppState, "mode" | "moves" | "review" | "line" | "variation">): BoardView | null {
  const { mode, moves, review, line, variation } = s;
  if (!mode) return null;
  const fenAt = (ply: number) => (ply === 0 ? moves[0]?.fenBefore ?? startFen(s) : moves[ply - 1]!.fenAfter);
  if (mode.type === "game") {
    const reviewForMove = review?.reviews.find((r) => r.ply === mode.ply);
    return {
      fen: fenAt(mode.ply),
      lastMoveUci: mode.ply > 0 ? moves[mode.ply - 1]!.uci : null,
      basePly: mode.ply,
      inVariation: false,
      lastClassification: reviewForMove?.classification ?? null,
      position: review?.positions[mode.ply] ?? null,
    };
  }
  const branch = mode.type === "engineVariation" ? line : variation;
  if (!branch) return null;
  const idx = mode.index;
  return {
    fen: idx === 0 ? fenAt(branch.startingPly) : branch.moves[idx - 1]!.fenAfter,
    lastMoveUci: idx === 0 ? (branch.startingPly > 0 ? moves[branch.startingPly - 1]!.uci : null) : branch.moves[idx - 1]!.uci,
    basePly: branch.startingPly,
    inVariation: true,
    lastClassification: null,
    position: null,
  };
}

function startFen(s: Pick<AppState, "moves">): string {
  return s.moves[0]?.fenBefore ?? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
}

export const ORDERED_CLASSIFICATIONS = CLASSIFICATION_ORDER;
