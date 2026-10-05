# ChessAnalyser

Free, local chess game analysis powered by Stockfish.

Import your public Chess.com games, analyse them on your own computer with Stockfish 19, and get a full game review: an interactive board, evaluation bar and graph, move classifications (including Brilliant moves), best moves, principal variations and plain-English explanations. No account, no subscription, no cloud.

## Requirements

- Node.js 22.12 or newer, and npm
- An internet connection for the first Stockfish download and for Chess.com syncing

## Start

```bash
git clone <this repository>
cd ChessAnalyser
npm install
npm run dev
```

Stockfish is installed automatically when required. ChessAnalyser opens at <http://127.0.0.1:5173>.

---

## Using it

1. Enter your Chess.com username. Public games are imported, newest month first. No Chess.com login is needed.
2. Open a game and click **Analyse game**. Results stream in position by position.
3. Step through the game:
   - **← / →** move backwards and forwards.
   - **Home / End** jump to the start or end.
   - **F** flips the board.
   - Click the evaluation graph to jump to any move.
4. Click **Show best line** to explore the engine's variation. Moving a piece from any position starts your own variation. The original game is never changed.
5. Pick the Navy, Orange or Pink palette from the header.

Analysis modes, which you can change per game or in Settings:

| Mode | Budget per position |
| --- | --- |
| Quick | 50,000 nodes |
| Standard (default) | 200,000 nodes, plus extra checks on possible Brilliant moves and close calls |
| Deep | 1,000,000 nodes, 3 lines |

### How moves are classified

ChessAnalyser measures each move by **expected-outcome loss**, not raw centipawns. Expected outcome is `P(win) + ½·P(draw)`, taken from Stockfish's WDL output. The loss is how much of that a move gives up compared with Stockfish's best move:

| Loss | Label |
| ---: | --- |
| ≤ 0.005 | Best |
| ≤ 0.02 | Excellent |
| ≤ 0.05 | Good |
| ≤ 0.10 | Inaccuracy |
| ≤ 0.20 | Mistake |
| > 0.20 | Blunder |

Some rules override these thresholds:

- **Only legal move:** labelled *Forced* and never criticised.
- **Allowing a forced mate:** at least a *Blunder*.
- **Close calls:** a move that lands within 0.01 of a boundary is re-searched, comparing the played move and the best move at the same budget.
- **Brilliant:** awarded only to an apparent sacrifice that Stockfish confirms in a dedicated multi-line search.

The thresholds live in [packages/shared/src/constants.ts](packages/shared/src/constants.ts). Every review records the engine version and the review algorithm version.

## Using an AI assistant (optional)

ChessAnalyser can expose a small, permission-controlled set of tools over [MCP](https://modelcontextprotocol.io). An AI client can then read your engine analysis, explain it, and show lines on the board. Stockfish stays authoritative; the AI only explains and points.

1. Keep ChessAnalyser running (`npm run dev`).
2. Add the MCP server to your client. For example, in Claude Code:

   ```bash
   claude mcp add chessanalyser -- npm run --silent --prefix /absolute/path/to/ChessAnalyser mcp
   ```

   For JSON-configured clients such as Claude Desktop:

   ```json
   {
     "mcpServers": {
       "chessanalyser": {
         "command": "npm",
         "args": ["run", "--silent", "--prefix", "/absolute/path/to/ChessAnalyser", "mcp"]
       }
     }
   }
   ```

3. In ChessAnalyser, click **AI Access: OFF** and choose **Current game** or **Entire library**.
4. Ask something like *"Why was this move losing?"*, then *"Show me the line."*

**AI access:**

- It is **off by default**.
- It lasts only for the current session and resets when ChessAnalyser restarts.
- **Current game** access switches off as soon as you open a different game.
- Turning access off takes effect immediately.

**What an AI client can do.** The tools only read analysis and adjust what the board shows:

- `get_active_game`, `list_games`, `get_game`, `get_position`, `get_move_review`
- `analyse_position`, `analyse_candidate`
- `show_position`, `show_variation`, `highlight_squares`, `draw_arrows`, `clear_overlays`

It cannot delete or edit games, run commands, or read files. It can only show engine lines that ChessAnalyser itself produced. Every tool call is logged locally under **Settings → AI access**.

## Privacy

- No ChessAnalyser cloud, no analytics, no telemetry, and no account.
- Games, analysis and settings are stored in a local SQLite database.
- The app only goes online to sync Chess.com and to download Stockfish.
- ChessAnalyser never sends your games to an AI provider. A connected AI client only receives the data it requests, and only while you allow it.

Everything lives in your user data folder:

| OS | Location |
| --- | --- |
| macOS | `~/Library/Application Support/ChessAnalyser/` |
| Linux | `~/.local/share/ChessAnalyser/` |
| Windows | `%APPDATA%\ChessAnalyser\` |

This folder holds the database, the managed Stockfish, logs, and a private session file used by the MCP bridge. Set `CHESSANALYSER_DATA_DIR` to use a different folder.

## The engine

On startup ChessAnalyser looks for an engine in this order:

1. `CHESSANALYSER_STOCKFISH_PATH`, or the path set in Settings
2. Its own managed Stockfish 19
3. Stockfish 19 on your `PATH`
4. Download Stockfish 19 from the official GitHub release

Every download is checked against the SHA-256 in [engine-manifest.json](engine-manifest.json) before it is run. The engine must then identify itself as Stockfish 19 over UCI.

On macOS, if Stockfish can't be installed, ChessAnalyser falls back to the Sjeng engine that ships with Apple's Chess app. The UI says so clearly. In that mode, reviews use conservative centipawn labels and Brilliant detection is turned off.

`npm run setup` installs or verifies the engine without starting the app.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Backend and web UI with live reload |
| `npm run mcp` | MCP server over stdio (for AI clients) |
| `npm run setup` | Install or verify Stockfish |
| `npm test` | Unit and integration tests (no engine download needed) |
| `npm run test:engine` | Integration tests against real Stockfish 19 (downloads it once into `.data/`) |
| `npm run test:e2e` | Browser tests (Playwright; run `npx playwright install chromium` once) |
| `npm run lint` / `npm run typecheck` | Code quality |
| `npm run build` then `npm start` | Production build, served from a single local port |

## Architecture

```text
Chess.com PubAPI ──► ChessAnalyser backend (Fastify, 127.0.0.1 only) ◄── MCP adapter ◄── AI client
                       │ GameService · ImportService · AnalysisService
                       │ VariationService · AiPermissionService · UiSessionService
                       ├── SQLite (better-sqlite3, numbered migrations)
                       ├── Stockfish 19 (one managed process, priority queue)
                       └── WebSocket ──► React UI
```

| Path | Contents |
| --- | --- |
| `apps/web` | React + Vite UI. The board is isolated behind `<ChessBoard />`. |
| `apps/server` | Local HTTP/WebSocket API, services, security |
| `apps/mcp` | Thin stdio MCP adapter that calls the HTTP API. It contains no chess logic. |
| `packages/chess-core` | PGN parsing, move validation, material and tactics helpers (chess.js) |
| `packages/engine` | Stockfish (UCI) and Sjeng (xboard) adapters, installer, analysis queue and cache |
| `packages/review` | Classifier, `BrilliantDetector`, tactical tags, explanations |
| `packages/chesscom` | Chess.com PubAPI client with ETag/Last-Modified caching and 429 back-off |
| `packages/database` | Schema, migrations, repositories |
| `packages/shared` | Canonical types and Zod schemas used by the HTTP API, MCP and tests |

**Design rule:** Stockfish decides the chess. ChessAnalyser structures and presents it. An LLM explains it and, when permitted, controls the analysis view.

**Local security:** the API listens only on `127.0.0.1`. Every endpoint except `/api/health` requires a per-run 256-bit token. Browser requests are additionally checked for Origin, Host and content type. The WebSocket handshake is authenticated, and the page is served with a strict Content Security Policy.

## Licence

ChessAnalyser's own code is [MIT](LICENSE) licensed. Stockfish (GPLv3) and Sjeng (GPL) are separate programs that ChessAnalyser runs as external processes and does not redistribute. See [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
