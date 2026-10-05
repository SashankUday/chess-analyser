// `npm run mcp` / `chessanalyser mcp`: MCP over stdio. stdout carries protocol messages only.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./server";

serveStdio(() => createMcpServer(), {
  onerror: (err) => process.stderr.write(`chessanalyser-mcp: ${err.message}\n`),
});
