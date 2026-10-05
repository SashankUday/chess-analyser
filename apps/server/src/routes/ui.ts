import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import {
  AiAccessBody,
  AnalyseGameBody,
  AnalysePositionBody,
  AnalyseVariationBody,
  APP_VERSION,
  CandidateBody,
  CreateProfileBody,
  CreateVariationBody,
  ExtendVariationBody,
  GamesQuery,
  PatchSettingsBody,
  PlySchema,
  SyncBody,
} from "@chessanalyser/shared";
import { dataPaths } from "@chessanalyser/shared/node";
import type { AppContext } from "../context";
import { fromZod } from "../errors";

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw fromZod(r.error);
  return r.data;
}

const idParam = (params: unknown, key: string) => (params as Record<string, string>)[key]!;
const plyParam = (params: unknown) => parse(PlySchema, Number((params as Record<string, string>).ply));

/** Routes used by the web UI (bearer UI token; see security.ts). */
export function registerUiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/health", async () => ({
    ok: true,
    app: "ChessAnalyser",
    version: APP_VERSION,
    engine: ctx.engine.status.state,
  }));

  // ---- settings & engine ----
  app.get("/api/settings", async () => ctx.db.getSettings());

  app.patch("/api/settings", async (req) => {
    const patch = parse(PatchSettingsBody, req.body);
    const before = ctx.db.getSettings();
    const after = ctx.db.updateSettings(patch);
    const engineChanged =
      before.threads !== after.threads || before.hashMb !== after.hashMb || before.stockfishPath !== after.stockfishPath;
    if (engineChanged) void ctx.engine.restart();
    return after;
  });

  app.get("/api/engine", async () => ({
    status: ctx.engine.status,
    identity: ctx.engine.manager.identity
      ? { ...ctx.engine.manager.identity, binarySha256: undefined }
      : null,
    threads: ctx.engine.threads(),
    paused: ctx.engine.manager.isPaused,
    dataDir: dataPaths.root(),
    database: dataPaths.database(),
  }));

  app.post("/api/engine/retry", async () => {
    void ctx.engine.restart();
    return { started: true };
  });

  app.post("/api/engine/reinstall", async () => {
    void ctx.engine.reinstall();
    return { started: true };
  });

  app.post("/api/engine/clear-cache", async () => ({ removed: ctx.db.clearEngineCache() }));

  // ---- Chess.com ----
  app.get("/api/profiles", async () => ctx.db.listProfiles());

  app.post("/api/chesscom/profiles", async (req) => {
    const body = parse(CreateProfileBody, req.body);
    return ctx.imports.addProfile(body.username);
  });

  app.post("/api/chesscom/:profileId/sync", async (req) => {
    const body = parse(SyncBody, req.body ?? {});
    const profileId = idParam(req.params, "profileId");
    const running = ctx.imports.sync(profileId, body.months);
    running.catch(() => undefined); // reported over WebSocket
    return { started: true };
  });

  // ---- games ----
  app.get("/api/games", async (req) => ctx.games.list(parse(GamesQuery, req.query)));
  app.get("/api/games/:gameId", async (req) => ctx.games.get(idParam(req.params, "gameId")));
  app.get("/api/games/:gameId/moves", async (req) => ctx.games.moves(idParam(req.params, "gameId")));

  // ---- analysis & review ----
  app.post("/api/games/:gameId/analyse", async (req) => {
    const body = parse(AnalyseGameBody, req.body ?? {});
    return ctx.analysis.analyseGame(idParam(req.params, "gameId"), body.preset);
  });

  app.get("/api/games/:gameId/review", async (req) => ctx.analysis.getReview(idParam(req.params, "gameId")));

  app.post("/api/games/:gameId/positions/:ply/analyse", async (req) => {
    const body = parse(AnalysePositionBody, req.body ?? {});
    return ctx.analysis.analysePosition(idParam(req.params, "gameId"), plyParam(req.params), body);
  });

  app.post("/api/games/:gameId/positions/:ply/candidates", async (req) => {
    const body = parse(CandidateBody, req.body);
    return ctx.analysis.analyseCandidate(idParam(req.params, "gameId"), plyParam(req.params), body.move, {
      preset: body.preset,
      kind: "POSITION",
    });
  });

  app.get("/api/jobs/:jobId", async (req) => ctx.analysis.getJob(idParam(req.params, "jobId")));
  app.delete("/api/jobs/:jobId", async (req) => ctx.analysis.cancel(idParam(req.params, "jobId")));

  // ---- variations (backend owns the state) ----
  app.post("/api/variations", async (req) => ctx.variations.create(parse(CreateVariationBody, req.body)));

  app.post("/api/variations/:variationId/moves", async (req) => {
    const body = parse(ExtendVariationBody, req.body);
    return ctx.variations.extend(idParam(req.params, "variationId"), body.atIndex, body.move);
  });

  app.post("/api/variations/:variationId/analyse", async (req) => {
    const body = parse(AnalyseVariationBody, req.body);
    const fen = ctx.variations.fenAt(idParam(req.params, "variationId"), body.index);
    return ctx.analysis.analyseFen(fen, { preset: body.preset, multipv: 1 });
  });

  app.get("/api/variations/:variationId/family", async (req) => ctx.variations.family(idParam(req.params, "variationId")));

  app.get("/api/variations/:variationId", async (req) => ctx.variations.get(idParam(req.params, "variationId")));

  app.post("/api/variations/:variationId/save", async (req) => ctx.variations.save(idParam(req.params, "variationId")));

  app.delete("/api/variations/:variationId", async (req) => {
    ctx.variations.discard(idParam(req.params, "variationId"));
    return { discarded: true };
  });

  app.get("/api/games/:gameId/variations", async (req) => ctx.variations.listSaved(idParam(req.params, "gameId")));

  app.get("/api/lines/:lineId", async (req) => ctx.variations.line(idParam(req.params, "lineId")));

  // ---- AI access (the UI alone can change it; MCP cannot grant itself access) ----
  app.get("/api/ai/access", async () => ctx.permission.access);

  app.post("/api/ai/access", async (req) => ctx.permission.set(parse(AiAccessBody, req.body)));

  app.get("/api/ai/audit", async () => ctx.db.listAudit(100));
}
