import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, waitFor, type Harness, type UiClient } from "../../server/test/harness";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let h: Harness;
let client: Client;
let ui: UiClient;
let gameA: string;
let gameB: string;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0]!.text;
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // error text
  }
  return { isError: !!res.isError, text, data: data as Record<string, unknown> };
}
const setAccess = (json: unknown) => h.ui("/api/ai/access", { method: "POST", json });

beforeAll(async () => {
  h = await startHarness();
  gameA = h.importFixture("hanging-queen", "live/1");
  gameB = h.importFixture("missed-mate", "live/2");
  // Review game A so get_move_review has data.
  const job = (await (await h.ui(`/api/games/${gameA}/analyse`, { method: "POST", json: { preset: "quick" } })).json()) as { id: string };
  await waitFor(async () => ((await (await h.ui(`/api/jobs/${job.id}`)).json()) as { state: string }).state === "completed");

  ui = await h.connect();
  ui.state(gameA, 4);
  await waitFor(async () => h.server.ctx.ui.active()?.gameId === gameA);

  const transport = new StdioClientTransport({
    command: path.join(root, "node_modules", ".bin", "tsx"),
    args: [path.join(root, "apps", "mcp", "src", "index.ts")],
    env: { ...(process.env as Record<string, string>), CHESSANALYSER_DATA_DIR: h.dir },
    stderr: "pipe",
  });
  client = new Client({ name: "chessanalyser-test", version: "1.0.0" });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  ui?.close();
  await h?.stop();
});

describe("MCP stdio server", () => {
  it("exposes exactly the documented tools and nothing dangerous", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "analyse_candidate",
        "analyse_position",
        "clear_overlays",
        "draw_arrows",
        "get_active_game",
        "get_game",
        "get_move_review",
        "get_position",
        "highlight_squares",
        "list_games",
        "show_position",
        "show_variation",
      ].sort(),
    );
    for (const banned of ["delete_game", "replace_pgn", "execute_shell", "read_file", "write_file", "download_url", "arbitrary_sql"]) {
      expect(names).not.toContain(banned);
    }
  });

  it("AI OFF rejects reads", async () => {
    await setAccess({ mode: "off" });
    const r = await call("get_game", { game_id: gameA });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("AI_ACCESS_DENIED");
  });

  it("CURRENT GAME allows the authorised game and rejects another", async () => {
    await setAccess({ mode: "current_game", gameId: gameA });
    expect((await call("get_game", { game_id: gameA })).isError).toBe(false);
    const other = await call("get_game", { game_id: gameB });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("AI_ACCESS_DENIED");
  });

  it("LIBRARY allows game retrieval", async () => {
    await setAccess({ mode: "library" });
    const r = await call("get_game", { game_id: gameB });
    expect(r.isError).toBe(false);
    expect(r.data.game_id).toBe(gameB);
  });

  it("answers 'why was this a blunder' and shows the engine line", async () => {
    await setAccess({ mode: "current_game", gameId: gameA });
    const active = await call("get_active_game");
    expect(active.data).toMatchObject({ game_id: gameA, current_ply: 4 });
    const review = await call("get_move_review", { game_id: gameA, ply: 4 });
    expect(review.data).toMatchObject({ classification: "Blunder", move: "2... Qh4" });
    const lineId = (review.data.best_line as { line_id: string }).line_id;

    const shown = call("show_variation", { line_id: lineId });
    const event = await ui.next("ui.variation.show");
    expect((await shown).isError).toBe(false);
    expect(event).toMatchObject({ type: "ui.variation.show", gameId: gameA, startingPly: 3 });
  });

  it("show_variation rejects an invented line", async () => {
    const r = await call("show_variation", { line_id: "pv_48372" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("UNKNOWN_LINE");
  });

  it("rejects illegal candidate moves and analyses legal ones", async () => {
    const bad = await call("analyse_candidate", { game_id: gameA, ply: 2, move: "Kh1" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("ILLEGAL_MOVE");
    const good = await call("analyse_candidate", { game_id: gameA, ply: 2, move: "Nf3" });
    expect(good.isError).toBe(false);
    expect((good.data.candidate as { san: string }).san).toBe("Nf3");
  });

  it("rejects invalid input at the schema boundary", async () => {
    const r = await client.callTool({ name: "highlight_squares", arguments: { squares: ["z9"] } });
    expect(r.isError).toBe(true);
  });

  it("revokes access immediately", async () => {
    await setAccess({ mode: "library" });
    expect((await call("get_position", { game_id: gameA, ply: 1 })).isError).toBe(false);
    await setAccess({ mode: "off" });
    const r = await call("get_position", { game_id: gameA, ply: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("AI_ACCESS_DENIED");
  });

  it("reports when ChessAnalyser is not running", async () => {
    ui.close();
    await h.server.close();
    const r = await call("get_active_game");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("ChessAnalyser is not currently running.\nStart it with npm run dev.");
  });
});
