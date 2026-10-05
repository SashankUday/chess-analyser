// Localhost is treated as a security boundary (spec §52): every chess-data route needs a bearer
// token, browsers must come from the app's own origin, and the Host header must be loopback.
import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { WS_PROTOCOL, WS_TOKEN_PREFIX } from "@chessanalyser/shared";
import { HttpError } from "./errors";

export interface SecurityConfig {
  /** Token injected into the web UI's HTML. Grants the UI scope. */
  uiToken: string;
  /** Token in session.json for the MCP process. Grants only the /api/mcp scope. */
  mcpToken: string;
  /** Exact origins allowed to make browser requests (e.g. http://127.0.0.1:4800). */
  allowedOrigins: Set<string>;
  /** host:port values accepted in the Host header (DNS-rebinding defence). */
  allowedHosts: Set<string>;
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("hex"); // 256 bits
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

export type Scope = "public" | "ui" | "mcp";

export function scopeOf(url: string): Scope {
  const path = url.split("?")[0]!;
  if (path === "/api/health") return "public";
  if (path.startsWith("/api/mcp/")) return "mcp";
  return "ui";
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Fastify onRequest hook for all /api routes. */
export function apiGuard(config: SecurityConfig) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    checkHost(req, config);
    const scope = scopeOf(req.url);
    const origin = req.headers.origin;

    if (req.method === "OPTIONS") {
      // No CORS: the UI is same-origin (or proxied in development). Preflights are refused.
      throw new HttpError(403, "CORS_REFUSED", "Cross-origin requests are not allowed.");
    }
    if (scope === "public") return;

    // A browser request must come from the app itself.
    if (origin !== undefined && !config.allowedOrigins.has(origin)) {
      throw new HttpError(403, "BAD_ORIGIN", "Requests from this origin are not allowed.");
    }

    const token = bearer(req);
    const expected = scope === "mcp" ? config.mcpToken : config.uiToken;
    if (!token || !safeEqual(token, expected)) {
      throw new HttpError(401, "UNAUTHORIZED", "Missing or invalid ChessAnalyser session token.");
    }

    if (MUTATING.has(req.method)) {
      // UI mutations must carry an Origin (all modern browsers send it on POST/PATCH/DELETE).
      if (scope === "ui" && origin === undefined) {
        throw new HttpError(403, "BAD_ORIGIN", "Missing Origin header.");
      }
      // MCP calls come from a local Node process, never from a web page.
      if (scope === "mcp" && origin !== undefined) {
        throw new HttpError(403, "BAD_ORIGIN", "MCP endpoints do not accept browser requests.");
      }
      const hasBody = req.method !== "DELETE" || Number(req.headers["content-length"] ?? 0) > 0;
      const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (hasBody && type !== "application/json") {
        throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Requests must be sent as application/json.");
      }
    }
  };
}

export function checkHost(req: FastifyRequest, config: SecurityConfig): void {
  const host = (req.headers.host ?? "").toLowerCase();
  if (!config.allowedHosts.has(host)) {
    throw new HttpError(403, "BAD_HOST", "Unexpected Host header.");
  }
}

/** WebSocket handshake: token travels as a subprotocol, Origin must be the app's. */
export function wsGuard(config: SecurityConfig) {
  return async (req: FastifyRequest) => {
    checkHost(req, config);
    const origin = req.headers.origin;
    if (!origin || !config.allowedOrigins.has(origin)) {
      throw new HttpError(403, "BAD_ORIGIN", "WebSocket origin not allowed.");
    }
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim());
    const tokenProto = protocols.find((p) => p.startsWith(WS_TOKEN_PREFIX));
    const token = tokenProto?.slice(WS_TOKEN_PREFIX.length) ?? "";
    if (!protocols.includes(WS_PROTOCOL) || !safeEqual(token, config.uiToken)) {
      throw new HttpError(401, "UNAUTHORIZED", "WebSocket authentication failed.");
    }
  };
}

/** Strict CSP for the HTML that carries the UI token. */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};
