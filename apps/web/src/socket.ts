import { WS_PROTOCOL, WS_TOKEN_PREFIX, type ClientEvent, type ServerEvent } from "@chessanalyser/shared";
import { sessionToken } from "./api";

type Listener = (event: ServerEvent) => void;

/** Authenticated WebSocket to the backend, with automatic reconnection. */
class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private pending: ClientEvent | null = null;
  private retry = 0;

  connect(): void {
    const token = sessionToken();
    if (!token || this.ws) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url, [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${token}`]);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.pending) ws.send(JSON.stringify(this.pending));
    };
    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(String(msg.data)) as ServerEvent;
        for (const l of this.listeners) l(event);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      this.ws = null;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Report what the user is looking at; the latest state is re-sent after reconnecting. */
  send(event: ClientEvent): void {
    this.pending = event;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }
}

export const socket = new Socket();
