import type { ChessDb } from "@chessanalyser/database";
import { ChessComClient, ChessComSource, ChessComUnavailableError, ProfileNotFoundError } from "@chessanalyser/chesscom";
import type { Profile } from "@chessanalyser/shared";
import { HttpError, notFound } from "../errors";
import type { Logger } from "../logger";
import type { UiSessionService } from "./ui-sessions";

export interface SyncResult {
  imported: number;
  failed: number;
}

/** Chess.com import (spec §24–25). Network access happens only here and in the engine installer. */
export class ImportService {
  private running = new Map<string, Promise<SyncResult>>();
  private readonly source: ChessComSource;

  constructor(
    private readonly db: ChessDb,
    private readonly ui: UiSessionService,
    private readonly log: Logger,
    private readonly client = new ChessComClient(),
  ) {
    this.source = new ChessComSource(client);
  }

  /** Register a Chess.com username after confirming the profile exists. */
  async addProfile(username: string): Promise<Profile> {
    try {
      await this.client.getArchives(username);
    } catch (err) {
      throw toHttp(err);
    }
    const profile = this.db.upsertProfile("chesscom", username);
    this.db.updateSettings({ chesscomUsername: profile.username });
    return profile;
  }

  isSyncing(profileId: string): boolean {
    return this.running.has(profileId);
  }

  /** Start (or join) a background sync. Progress is streamed over WebSocket. */
  sync(profileId: string, months?: number): Promise<SyncResult> {
    const profile = this.db.getProfile(profileId);
    if (!profile) throw notFound("Profile");
    const existing = this.running.get(profileId);
    if (existing) return existing;
    const run = this.run(profile, months).finally(() => this.running.delete(profileId));
    this.running.set(profileId, run);
    return run;
  }

  private async run(profile: Profile, months?: number): Promise<SyncResult> {
    let imported = 0;
    let failed = 0;
    this.log.info({ component: "chesscom", profile: profile.username }, "Chess.com sync started");
    try {
      const batches = this.source.months(profile, {
        months,
        getCache: (url) => this.db.getSyncCache(url),
        touchCache: (url) => this.db.touchSyncCache(url),
        onProgress: (message) => this.ui.broadcast({ type: "sync.progress", profileId: profile.id, message }),
      });
      for await (const batch of batches) {
        for (const g of batch.games) {
          const id = this.db.insertGame(
            {
              profileId: profile.id,
              source: "chesscom",
              sourceGameId: g.sourceGameId,
              url: g.url,
              white: g.white,
              black: g.black,
              result: g.result,
              playedAt: g.playedAt,
              timeControl: g.timeControl,
              timeClass: g.timeClass,
              eco: g.eco,
              openingName: g.openingName,
              variant: g.variant,
              supported: g.supported,
              userColour: g.userColour,
              pgn: g.pgn,
              startFen: g.startFen,
            },
            g.moves,
          );
          if (id) {
            imported += 1;
            this.ui.broadcast({ type: "game.imported", gameId: id });
          }
        }
        for (const e of batch.errors) {
          failed += 1;
          this.db.addImportFailure({ profileId: profile.id, archiveUrl: e.archiveUrl, sourceGameId: e.sourceGameId, error: e.error });
          this.log.warn({ component: "chesscom", game: e.sourceGameId }, `Skipped game: ${e.error}`);
        }
        // Only now is the month marked as seen, so an interrupted import is retried next time.
        this.db.putSyncCache(batch.archiveUrl, batch.cache.etag, batch.cache.lastModified);
      }
      this.db.markProfileSynced(profile.id);
      this.ui.broadcast({ type: "sync.completed", profileId: profile.id, imported, failed });
      this.log.info({ component: "chesscom", imported, failed }, "Chess.com sync completed");
      return { imported, failed };
    } catch (err) {
      const http = toHttp(err);
      this.ui.broadcast({ type: "sync.completed", profileId: profile.id, imported, failed, error: http.message });
      this.log.warn({ component: "chesscom", err: http.message }, "Chess.com sync failed");
      throw http;
    }
  }
}

function toHttp(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ProfileNotFoundError) return new HttpError(404, "PROFILE_NOT_FOUND", err.message);
  if (err instanceof ChessComUnavailableError) return new HttpError(502, "CHESSCOM_UNAVAILABLE", err.message);
  return new HttpError(500, "SYNC_FAILED", (err as Error).message ?? "Sync failed.");
}
