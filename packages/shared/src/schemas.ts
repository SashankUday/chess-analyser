// Shared request schemas (spec §70). Used by HTTP handlers, MCP tools and tests alike.
import { z } from "zod";

export const GameIdSchema = z.uuid();
export const PlySchema = z.number().int().nonnegative().max(2000);
export const SquareSchema = z.string().regex(/^[a-h][1-8]$/, "Expected a square such as e4");
export const OverlayRoleSchema = z.enum(["primary", "warning", "danger"]);
export const PresetSchema = z.enum(["quick", "standard", "deep"]);
export const PaletteSchema = z.enum(["navy", "orange", "pink"]);
/** SAN or UCI. Parsed and legality-checked by chess-core, never trusted. */
export const MoveTextSchema = z.string().trim().min(2).max(12);

export const PositionRef = z.object({
  gameId: GameIdSchema,
  ply: PlySchema,
});

export const CreateProfileBody = z.object({
  username: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[A-Za-z0-9_-]+$/, "Chess.com usernames contain only letters, numbers, - and _"),
});

export const SyncBody = z
  .object({
    /** Limit to the most recent N archive months. Omitted = all months. */
    months: z.number().int().positive().max(600).optional(),
  })
  .default({});

export const GameFilterSchema = z.enum([
  "all",
  "rapid",
  "blitz",
  "bullet",
  "daily",
  "classical",
  "wins",
  "draws",
  "losses",
  "analysed",
  "not_analysed",
]);

export const GamesQuery = z.object({
  profileId: z.uuid().optional(),
  filter: GameFilterSchema.default("all"),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const PatchSettingsBody = z
  .object({
    palette: PaletteSchema,
    defaultPreset: PresetSchema,
    threads: z.union([z.literal("auto"), z.number().int().min(1).max(64)]),
    hashMb: z.number().int().min(16).max(4096),
    stockfishPath: z.string().trim().min(1).max(1024).nullable(),
    chesscomUsername: z.string().trim().max(50).nullable(),
  })
  .partial()
  .strict();

export const AnalyseGameBody = z.object({ preset: PresetSchema.optional() }).default({});

export const AnalysePositionBody = z
  .object({
    preset: PresetSchema.optional(),
    multipv: z.number().int().min(1).max(5).optional(),
  })
  .default({});

export const CandidateBody = z.object({
  move: MoveTextSchema,
  preset: PresetSchema.optional(),
});

export const CreateVariationBody = z.object({
  gameId: GameIdSchema,
  startingPly: PlySchema,
  move: MoveTextSchema,
  sessionId: z.string().min(1).max(100).optional(),
});

export const ExtendVariationBody = z.object({
  /** Number of variation moves to keep before appending `move` (0 = replace the whole line). */
  atIndex: z.number().int().nonnegative().max(500),
  move: MoveTextSchema,
});

export const AnalyseVariationBody = z.object({
  /** Number of variation moves applied (1 = after the first variation move). */
  index: z.number().int().min(1).max(500),
  preset: PresetSchema.optional(),
});

export const EngineLineVariationBody = z.object({
  gameId: GameIdSchema,
  lineId: z.string().min(1).max(100),
});

export const AiAccessBody = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("current_game"), gameId: GameIdSchema }),
  z.object({ mode: z.literal("library") }),
]);

export const UiStateBody = z.object({
  sessionId: z.string().min(1).max(100),
  gameId: GameIdSchema.nullable(),
  ply: PlySchema.nullable(),
});

// ---- MCP tool inputs (spec §48). Snake_case to match the published tool contract. ----

export const AiGetGameInput = z.object({ game_id: GameIdSchema });

export const AiPositionInput = z.object({ game_id: GameIdSchema, ply: PlySchema });

export const AiAnalysePositionInput = z.object({
  game_id: GameIdSchema,
  ply: PlySchema,
  preset: PresetSchema.optional(),
  multipv: z.number().int().min(1).max(5).optional(),
});

export const AiCandidateInput = z.object({
  game_id: GameIdSchema,
  ply: PlySchema,
  move: MoveTextSchema.describe("A legal move in SAN (e.g. Kh1) or UCI (e.g. g1h1) from the position after `ply`."),
});

export const AiShowVariationInput = z.object({
  line_id: z.string().min(1).max(100).describe("An engine line id previously returned by ChessAnalyser."),
});

export const AiHighlightSquaresInput = z.object({
  squares: z.array(SquareSchema).min(1).max(64),
  role: OverlayRoleSchema.optional(),
});

export const AiDrawArrowsInput = z.object({
  arrows: z
    .array(z.object({ from: SquareSchema, to: SquareSchema, role: OverlayRoleSchema.optional() }))
    .min(1)
    .max(16),
});

export const AiEmptyInput = z.object({});

export const AiListGamesInput = z.object({
  filter: GameFilterSchema.default("all"),
  limit: z.number().int().min(1).max(50).default(20),
});

export type CreateProfileBodyT = z.infer<typeof CreateProfileBody>;
export type GamesQueryT = z.infer<typeof GamesQuery>;
export type GameFilter = z.infer<typeof GameFilterSchema>;
export type PatchSettingsBodyT = z.infer<typeof PatchSettingsBody>;
export type AiAccessBodyT = z.infer<typeof AiAccessBody>;
