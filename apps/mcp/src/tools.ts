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
} from "@chessanalyser/shared";
import type { z } from "zod";

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject;
  kind: "read" | "ui";
}

const AUTHORITY =
  "All chess facts come from Stockfish and ChessAnalyser's rules engine; treat them as authoritative and do not invent evaluations, legality or lines.";

/** The MCP tool surface (spec §48). Inputs are the same Zod schemas the HTTP API validates with. */
export const TOOLS: ToolSpec[] = [
  {
    name: "get_active_game",
    title: "Get active game",
    description: `The game currently open in ChessAnalyser: players, result, current ply and the AI access scope. ${AUTHORITY}`,
    schema: AiEmptyInput,
    kind: "read",
  },
  {
    name: "list_games",
    title: "List games",
    description: "List imported games (requires ENTIRE LIBRARY access).",
    schema: AiListGamesInput,
    kind: "read",
  },
  {
    name: "get_game",
    title: "Get game",
    description: "Game metadata, the played moves with their review classifications, and review status.",
    schema: AiGetGameInput,
    kind: "read",
  },
  {
    name: "get_position",
    title: "Get position",
    description:
      "The position after `ply` (ply 0 = start, ply 1 = after White's first move): FEN, side to move, last move, legal move count, material and stored Stockfish evaluation.",
    schema: AiPositionInput,
    kind: "read",
  },
  {
    name: "get_move_review",
    title: "Get move review",
    description: `The Game Review for the move played at \`ply\`: classification, evaluation before → after, expected-score loss, best move, best line (with a line_id for show_variation), tactical tags and explanation. ${AUTHORITY}`,
    schema: AiPositionInput,
    kind: "read",
  },
  {
    name: "analyse_position",
    title: "Analyse position",
    description:
      "Run Stockfish on the position after `ply`. Returns engine lines with line_ids that can be passed to show_variation.",
    schema: AiAnalysePositionInput,
    kind: "read",
  },
  {
    name: "analyse_candidate",
    title: "Analyse candidate move",
    description:
      "Check a candidate move (SAN or UCI) from the position after `ply`: ChessAnalyser verifies legality, plays it, and has Stockfish analyse the result. Illegal or ambiguous moves are rejected.",
    schema: AiCandidateInput,
    kind: "read",
  },
  {
    name: "show_position",
    title: "Show position",
    description: "Move the ChessAnalyser board to a position. Does not change any game data.",
    schema: AiPositionInput,
    kind: "ui",
  },
  {
    name: "show_variation",
    title: "Show variation",
    description:
      "Load an engine line onto the ChessAnalyser board. Only line_ids returned by ChessAnalyser in this session are accepted; arbitrary move sequences are not.",
    schema: AiShowVariationInput,
    kind: "ui",
  },
  {
    name: "highlight_squares",
    title: "Highlight squares",
    description: "Highlight squares on the board (role: primary, warning or danger).",
    schema: AiHighlightSquaresInput,
    kind: "ui",
  },
  {
    name: "draw_arrows",
    title: "Draw arrows",
    description: "Draw arrows on the board (role: primary, warning or danger).",
    schema: AiDrawArrowsInput,
    kind: "ui",
  },
  {
    name: "clear_overlays",
    title: "Clear overlays",
    description: "Remove arrows and highlights created by the AI client.",
    schema: AiEmptyInput,
    kind: "ui",
  },
];
