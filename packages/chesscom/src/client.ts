// Chess.com PubAPI client (spec §23–25). Read-only, public data, no login. Requests are serial and
// conditional (ETag / Last-Modified), and 429 responses back off politely.
import { APP_NAME, APP_VERSION, REPOSITORY_URL } from "@chessanalyser/shared";

/** Overridable only so automated browser tests can run against a local stand-in. */
export const PUBAPI_BASE = process.env.CHESSANALYSER_CHESSCOM_API ?? "https://api.chess.com/pub";

export const USER_AGENT = `${APP_NAME}/${APP_VERSION} (local open-source chess analysis${REPOSITORY_URL ? `; +${REPOSITORY_URL}` : ""})`;

export interface ChessComPlayer {
  username: string;
  rating?: number;
  result?: string;
}

export interface ChessComGame {
  url: string;
  pgn?: string;
  uuid?: string;
  time_control?: string;
  time_class?: string;
  end_time?: number;
  rules?: string;
  rated?: boolean;
  eco?: string;
  white: ChessComPlayer;
  black: ChessComPlayer;
}

export class ProfileNotFoundError extends Error {
  constructor(username: string) {
    super(`No Chess.com profile found for "${username}".`);
    this.name = "ProfileNotFoundError";
  }
}

export class ChessComUnavailableError extends Error {
  constructor(detail: string) {
    super(`Chess.com could not be reached (${detail}). Your previously imported games are still available.`);
    this.name = "ChessComUnavailableError";
  }
}

export interface ConditionalCache {
  etag: string | null;
  lastModified: string | null;
}

export type MonthResult =
  | { status: "not_modified" }
  | { status: "ok"; games: ChessComGame[]; etag: string | null; lastModified: string | null };

export interface ChessComClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Upper bound for any single backoff wait. */
  maxBackoffMs?: number;
}

export class ChessComClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;

  constructor(options: ChessComClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? 3;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
  }

  /** Monthly archive URLs, newest first. */
  async getArchives(username: string): Promise<string[]> {
    const res = await this.request(`${PUBAPI_BASE}/player/${encodeURIComponent(username.toLowerCase())}/games/archives`);
    if (res.status === 404) throw new ProfileNotFoundError(username);
    if (!res.ok) throw new ChessComUnavailableError(`HTTP ${res.status}`);
    const body = (await res.json()) as { archives?: string[] };
    return [...(body.archives ?? [])].reverse();
  }

  async getMonth(url: string, cache: ConditionalCache | null): Promise<MonthResult> {
    const headers: Record<string, string> = {};
    if (cache?.etag) headers["If-None-Match"] = cache.etag;
    if (cache?.lastModified) headers["If-Modified-Since"] = cache.lastModified;
    const res = await this.request(url, headers);
    if (res.status === 304) return { status: "not_modified" };
    if (!res.ok) throw new ChessComUnavailableError(`HTTP ${res.status}`);
    const body = (await res.json()) as { games?: ChessComGame[] };
    return {
      status: "ok",
      games: body.games ?? [],
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  }

  private async request(url: string, headers: Record<string, string> = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers } });
      } catch (err) {
        throw new ChessComUnavailableError((err as Error).message);
      }
      if (res.status !== 429 || attempt >= this.maxRetries) {
        if (res.status === 429) throw new ChessComUnavailableError("rate limited; try again later");
        return res;
      }
      // Respect Retry-After; otherwise back off exponentially. Never hammer the API.
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
      await this.sleep(Math.min(wait, this.maxBackoffMs));
    }
  }
}
