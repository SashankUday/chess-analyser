import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";

/** Routes used only by the MCP stdio adapter (bearer MCP token from session.json). */
export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/mcp/status", async () => ctx.ai.status());

  app.post("/api/mcp/tools/:tool", async (req) => {
    const tool = (req.params as { tool: string }).tool;
    return { result: await ctx.ai.call(tool, req.body ?? {}) };
  });
}
