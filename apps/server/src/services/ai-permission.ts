import { AI_ACCESS_DENIED, type AiAccess } from "@chessanalyser/shared";
import { HttpError } from "../errors";

/**
 * AI access (spec §47): OFF by default, in memory only, so every restart is OFF again. Every change
 * bumps the epoch, which invalidates anything an AI client was handed before (spec §51).
 */
export class AiPermissionService {
  private access_: AiAccess = { mode: "off" };
  private epoch_ = 1;
  private listeners = new Set<(a: AiAccess) => void>();

  get access(): AiAccess {
    return this.access_;
  }

  get epoch(): number {
    return this.epoch_;
  }

  onChange(listener: (a: AiAccess) => void): void {
    this.listeners.add(listener);
  }

  set(access: AiAccess): AiAccess {
    this.access_ = access;
    this.bump();
    return access;
  }

  /** CURRENT GAME access is bound to one game; opening another game turns it OFF. */
  gameChanged(gameId: string | null): void {
    if (this.access_.mode === "current_game" && this.access_.gameId !== gameId) {
      this.set({ mode: "off" });
    } else {
      this.bump();
    }
  }

  /** Throw unless the AI may read chess data — optionally for a specific game. */
  require(gameId?: string): void {
    const a = this.access_;
    if (a.mode === "off") {
      throw new HttpError(403, AI_ACCESS_DENIED, "AI access is disabled in ChessAnalyser. The user can enable it in the app.");
    }
    if (gameId && a.mode === "current_game" && a.gameId !== gameId) {
      throw new HttpError(403, AI_ACCESS_DENIED, "AI access is limited to the game currently open in ChessAnalyser.");
    }
  }

  allowsLibrary(): boolean {
    return this.access_.mode === "library";
  }

  private bump(): void {
    this.epoch_ += 1;
    for (const l of this.listeners) l(this.access_);
  }
}
