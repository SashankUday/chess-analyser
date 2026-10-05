import { describe, expect, it } from "vitest";
import { fixturePgn } from "../../../tests/fixtures";
import {
  ChessComClient,
  ChessComSource,
  ChessComUnavailableError,
  ProfileNotFoundError,
  USER_AGENT,
  openingNameFromUrl,
  type ChessComGame,
} from "../src";

const ARCHIVES = "https://api.chess.com/pub/player/alice/games/archives";
const M1 = "https://api.chess.com/pub/player/alice/games/2026/08";
const M2 = "https://api.chess.com/pub/player/alice/games/2026/09";

const apiGame = (id: number, pgn: string, extra: Partial<ChessComGame> = {}): ChessComGame => ({
  url: `https://www.chess.com/game/live/${id}`,
  pgn,
  time_control: "600",
  time_class: "rapid",
  end_time: 1_788_000_000 + id,
  rules: "chess",
  white: { username: "Alice", rating: 1328, result: "win" },
  black: { username: "opponentA", rating: 1309, result: "checkmated" },
  ...extra,
});

function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, headers: init.headers as Record<string, string> });
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return route(init);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

describe("ChessComClient", () => {
  it("sends an identifiable User-Agent and lists archives newest first", async () => {
    const f = fakeFetch({ [ARCHIVES]: () => json({ archives: [M1, M2] }) });
    const client = new ChessComClient({ fetchImpl: f.impl });
    expect(await client.getArchives("Alice")).toEqual([M2, M1]);
    expect(f.calls[0]!.headers["User-Agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^ChessAnalyser\//);
  });

  it("maps 404 to a clear profile-not-found error", async () => {
    const client = new ChessComClient({ fetchImpl: fakeFetch({}).impl });
    await expect(client.getArchives("nobody")).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it("sends conditional headers and reports 304", async () => {
    const f = fakeFetch({ [M1]: () => new Response(null, { status: 304 }) });
    const client = new ChessComClient({ fetchImpl: f.impl });
    const res = await client.getMonth(M1, { etag: '"abc"', lastModified: "Tue, 01 Sep 2026 00:00:00 GMT" });
    expect(res.status).toBe("not_modified");
    expect(f.calls[0]!.headers["If-None-Match"]).toBe('"abc"');
    expect(f.calls[0]!.headers["If-Modified-Since"]).toBe("Tue, 01 Sep 2026 00:00:00 GMT");
  });

  it("honours Retry-After on 429 and does not retry aggressively", async () => {
    let n = 0;
    const waits: number[] = [];
    const f = fakeFetch({
      [M1]: () => (++n < 3 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : json({ games: [] })),
    });
    const client = new ChessComClient({ fetchImpl: f.impl, sleep: async (ms) => void waits.push(ms) });
    await client.getMonth(M1, null);
    expect(waits).toEqual([2000, 2000]);

    const always = fakeFetch({ [M2]: () => new Response("", { status: 429 }) });
    const waits2: number[] = [];
    const limited = new ChessComClient({ fetchImpl: always.impl, sleep: async (ms) => void waits2.push(ms) });
    await expect(limited.getMonth(M2, null)).rejects.toBeInstanceOf(ChessComUnavailableError);
    expect(always.calls).toHaveLength(4);
    expect(waits2).toEqual([2000, 4000, 8000]);
  });

  it("reports network failures as Chess.com unavailable", async () => {
    const client = new ChessComClient({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const err = await client.getArchives("alice").catch((e) => e);
    expect(err).toBeInstanceOf(ChessComUnavailableError);
    expect(err.message).toContain("previously imported games are still available");
  });
});

describe("ChessComSource", () => {
  it("imports games, skips unchanged months and isolates corrupt PGNs", async () => {
    const good = fixturePgn("castling").replace('[Result "*"]', '[Result "1-0"]\n[ECO "C50"]\n[ECOUrl "https://www.chess.com/openings/Italian-Game-Giuoco-Piano"]');
    const f = fakeFetch({
      [ARCHIVES]: () => json({ archives: [M1, M2] }),
      [M2]: () =>
        json(
          {
            games: [
              apiGame(1, good),
              apiGame(2, '[Event "x"]\n\n1. e4 e5 2. Ke3 Qxz9 *'),
              apiGame(3, fixturePgn("chess960"), { rules: "chess960" }),
            ],
          },
          { etag: '"m2"' },
        ),
      [M1]: () => new Response(null, { status: 304 }),
    });
    const source = new ChessComSource(new ChessComClient({ fetchImpl: f.impl }));
    const profile = { id: "p", source: "chesscom" as const, username: "alice", createdAt: "", lastSyncAt: null };
    const batches = [];
    for await (const b of source.months(profile, { getCache: (url) => (url === M1 ? { etag: '"m1"', lastModified: null } : null) })) {
      batches.push(b);
    }
    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch!.cache.etag).toBe('"m2"');
    expect(batch!.errors).toHaveLength(1);
    expect(batch!.games).toHaveLength(2);

    const g = batch!.games[0]!;
    expect(g).toMatchObject({
      sourceGameId: "live/1",
      userColour: "white",
      timeClass: "rapid",
      eco: "C50",
      openingName: "Italian Game Giuoco Piano",
      supported: true,
    });
    expect(g.moves.length).toBe(14);
    const variant = batch!.games[1]!;
    expect(variant.supported).toBe(false);
    expect(variant.variant).toBe("chess960");
    expect(variant.moves).toEqual([]);
  });

  it("derives opening names from ECO URLs", () => {
    expect(openingNameFromUrl("https://www.chess.com/openings/Sicilian-Defense-Bowdler-Attack")).toBe(
      "Sicilian Defense Bowdler Attack",
    );
    expect(openingNameFromUrl(null)).toBeNull();
  });
});
