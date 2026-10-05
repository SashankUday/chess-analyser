// Starts ChessAnalyser for browser tests: production web build, deterministic mock engine,
// a throwaway data directory and a local stand-in for the Chess.com PubAPI.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pgn = (name: string) => fs.readFileSync(path.join(root, "tests/fixtures/pgn", `${name}.pgn`), "utf8");

const MOCK_PORT = 4871;
const base = `http://127.0.0.1:${MOCK_PORT}/pub`;
const games = [
  { name: "hanging-queen", id: 9001, end: 1_790_000_000 },
  { name: "sacrifice-legal-mate", id: 9002, end: 1_790_100_000 },
  { name: "missed-mate", id: 9003, end: 1_790_200_000 },
].map((g) => ({
  url: `https://www.chess.com/game/live/${g.id}`,
  pgn: pgn(g.name).replace('[White "W"]', '[White "e2euser"]').replace('[Black "B"]', '[Black "opponentA"]'),
  time_control: "600",
  time_class: "rapid",
  end_time: g.end,
  rules: "chess",
  white: { username: "e2euser", rating: 1328 },
  black: { username: "opponentA", rating: 1309 },
}));

http
  .createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/pub/player/e2euser/games/archives") {
      res.end(JSON.stringify({ archives: [`${base}/player/e2euser/games/2026/09`] }));
    } else if (req.url === "/pub/player/e2euser/games/2026/09") {
      res.setHeader("ETag", '"e2e"');
      res.end(JSON.stringify({ games }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  })
  .listen(MOCK_PORT, "127.0.0.1");

process.env.CHESSANALYSER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ca-e2e-"));
process.env.CHESSANALYSER_ENGINE = "mock";
process.env.CHESSANALYSER_MOCK_DELAY_MS = "40";
process.env.CHESSANALYSER_CHESSCOM_API = base;
process.env.CHESSANALYSER_LOG_FILE = "0";

const { startServer } = await import("../../apps/server/src/server");
await startServer({ port: Number(process.env.E2E_PORT ?? 4870), webDir: path.join(root, "apps/web/dist") });
