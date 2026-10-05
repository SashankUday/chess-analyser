import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { WS_PROTOCOL } from "@chessanalyser/shared";
import type { AppContext } from "./context";
import { HttpError } from "./errors";
import { registerMcpRoutes } from "./routes/mcp";
import { registerUiRoutes } from "./routes/ui";
import { SECURITY_HEADERS, apiGuard, checkHost, contentSecurityPolicy, wsGuard } from "./security";

export const TOKEN_PLACEHOLDER = "%CHESSANALYSER_TOKEN%";

export interface BuildOptions {
  /** Directory with the built web UI (production). Omitted in development, where Vite serves it. */
  webDir?: string;
}

export async function buildApp(ctx: AppContext, options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    // Per-request logs are off: they add noise and URLs are all we would ever log anyway.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
  });

  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 64 * 1024,
      handleProtocols: (protocols: Set<string>) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
    },
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/")) return apiGuard(ctx.security)(req, reply);
    if (req.url === "/ws" || req.url.startsWith("/ws?")) return; // guarded on the route
    checkHost(req, ctx.security);
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (!reply.getHeader("cache-control") && String(reply.getHeader("content-type") ?? "").includes("json")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? "BAD_REQUEST", message: e.message } });
    }
    ctx.log.error({ err: e.message, url: req.url.split("?")[0] }, "Unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong in ChessAnalyser." } });
  });

  app.get("/ws", { websocket: true, preValidation: wsGuard(ctx.security) }, (socket) => {
    ctx.ui.attach(socket);
    socket.send(JSON.stringify({ type: "engine.status", status: ctx.engine.status }));
    socket.send(JSON.stringify({ type: "ai.access", access: ctx.permission.access }));
  });

  registerUiRoutes(app, ctx);
  registerMcpRoutes(app, ctx);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "No such endpoint." } });
    }
    if (options.webDir) return sendIndex(reply, options.webDir, ctx.security.uiToken);
    return reply.status(404).send("Not found");
  });

  if (options.webDir) {
    // Built assets and root files (favicon). index.html is never served raw: "/" and unknown paths
    // go through sendIndex, which injects the token and the CSP.
    await app.register(fastifyStatic, {
      root: options.webDir,
      prefix: "/",
      index: false,
      wildcard: false,
      decorateReply: false,
      allowedPath: (p) => p !== "/index.html",
    });
    app.get("/", (_req, reply) => sendIndex(reply, options.webDir!, ctx.security.uiToken));
  }

  return app;
}

function sendIndex(reply: import("fastify").FastifyReply, webDir: string, token: string) {
  const html = fs.readFileSync(path.join(webDir, "index.html"), "utf8").replace(TOKEN_PLACEHOLDER, token);
  return reply
    .header("Content-Type", "text/html; charset=utf-8")
    .header("Cache-Control", "no-store")
    .header("Content-Security-Policy", contentSecurityPolicy())
    .send(html);
}
