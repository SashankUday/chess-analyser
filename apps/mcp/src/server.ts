import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { APP_VERSION } from "@chessanalyser/shared";
import { AppError, callApp } from "./client";
import { TOOLS } from "./tools";

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * ChessAnalyser's MCP server: a thin adapter (spec §45). Each tool forwards validated input to the
 * local HTTP API; there is no chess logic here, and nothing outside the documented tools is exposed.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "chessanalyser", title: "ChessAnalyser", version: APP_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "ChessAnalyser is a local chess analysis app. Stockfish is authoritative for evaluations, best moves and legality — explain its results rather than replacing them. Start with get_active_game. Plies count half-moves: ply 1 is White's first move. To display a line, pass a line_id returned by ChessAnalyser to show_variation. If a tool says AI access is disabled, ask the user to enable AI access in ChessAnalyser.",
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: {
          readOnlyHint: tool.kind === "read",
          destructiveHint: false,
          idempotentHint: tool.kind === "ui",
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          const body = (await callApp(`/api/mcp/tools/${tool.name}`, { method: "POST", body: args ?? {} })) as {
            result: unknown;
          };
          return text(body.result);
        } catch (err) {
          if (err instanceof AppError) return text(err.code === "NOT_RUNNING" ? err.message : `${err.code}: ${err.message}`, true);
          return text(`ERROR: ${(err as Error).message}`, true);
        }
      },
    );
  }
  return server;
}
