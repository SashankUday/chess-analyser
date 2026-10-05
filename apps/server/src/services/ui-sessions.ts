import crypto from "node:crypto";
import type { WebSocket } from "ws";
import type { Arrow, BoardMode, ClientEvent, ServerEvent, SquareHighlight } from "@chessanalyser/shared";

/** Server-side view of one open browser tab (spec §51). AI writes only ever touch this state. */
export interface UiSessionState {
  id: string;
  gameId: string | null;
  ply: number | null;
  boardMode: BoardMode | null;
  overlays: { arrows: Arrow[]; squares: SquareHighlight[] };
  connectedAt: number;
  lastActiveAt: number;
}

interface Session extends UiSessionState {
  socket: WebSocket;
}

export class UiSessionService {
  private sessions = new Map<string, Session>();
  private listeners = new Set<(s: UiSessionState, previousGameId: string | null) => void>();
  private closeListeners = new Set<(sessionId: string) => void>();

  /** Called when a session reports a different open game. */
  onGameChange(listener: (s: UiSessionState, previousGameId: string | null) => void): void {
    this.listeners.add(listener);
  }

  onClose(listener: (sessionId: string) => void): void {
    this.closeListeners.add(listener);
  }

  attach(socket: WebSocket): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sessions.set(id, {
      id,
      socket,
      gameId: null,
      ply: null,
      boardMode: null,
      overlays: { arrows: [], squares: [] },
      connectedAt: now,
      lastActiveAt: now,
    });
    socket.on("message", (raw) => this.onMessage(id, raw.toString()));
    socket.on("close", () => {
      this.sessions.delete(id);
      for (const l of this.closeListeners) l(id);
    });
    this.send(id, { type: "session.ready", sessionId: id });
    return id;
  }

  /** The most recently active tab — the one an AI client's writes resolve against. */
  active(): UiSessionState | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) if (!best || s.lastActiveAt > best.lastActiveAt) best = s;
    return best ? this.view(best) : null;
  }

  get(id: string): UiSessionState | null {
    const s = this.sessions.get(id);
    return s ? this.view(s) : null;
  }

  update(id: string, patch: Partial<Pick<UiSessionState, "boardMode" | "overlays">>): void {
    const s = this.sessions.get(id);
    if (s) Object.assign(s, patch);
  }

  send(id: string, event: ServerEvent): void {
    const s = this.sessions.get(id);
    if (s && s.socket.readyState === s.socket.OPEN) s.socket.send(JSON.stringify(event));
  }

  broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const s of this.sessions.values()) if (s.socket.readyState === s.socket.OPEN) s.socket.send(data);
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.socket.close(1001, "Server shutting down");
  }

  private onMessage(id: string, raw: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    let event: ClientEvent;
    try {
      event = JSON.parse(raw) as ClientEvent;
    } catch {
      return;
    }
    if (event.type !== "ui.state") return;
    const gameId = typeof event.gameId === "string" ? event.gameId : null;
    const ply = typeof event.ply === "number" && Number.isInteger(event.ply) && event.ply >= 0 ? event.ply : null;
    const previous = s.gameId;
    s.gameId = gameId;
    s.ply = ply;
    s.lastActiveAt = Date.now();
    if (previous !== gameId) {
      s.boardMode = gameId && ply !== null ? { type: "game", gameId, ply } : null;
      s.overlays = { arrows: [], squares: [] };
      for (const l of this.listeners) l(this.view(s), previous);
    } else if (gameId && ply !== null && s.boardMode?.type === "game") {
      s.boardMode = { type: "game", gameId, ply };
    }
  }

  private view(s: Session): UiSessionState {
    const { socket: _socket, ...state } = s;
    return state;
  }
}
