import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EngineCrashedError } from "./types";

type Waiter = {
  predicate: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
};

/** Line-buffered wrapper around an engine child process speaking a text protocol (UCI or xboard). */
export class EngineProcess {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private waiters: Waiter[] = [];
  private listeners = new Set<(line: string) => void>();
  private exitError: Error | null = null;
  readonly exited: Promise<void>;

  constructor(binary: string, options: { cwd?: string; args?: string[] } = {}) {
    this.child = spawn(binary, options.args ?? [], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", () => {
      // Engines occasionally write diagnostics to stderr; never interpreted as protocol output.
    });
    this.child.stdin.on("error", () => {
      // EPIPE after the engine died is reported through the exit handler.
    });
    this.exited = new Promise((resolve) => {
      const onGone = (err?: Error) => {
        if (this.exitError) return;
        this.exitError = err ?? new EngineCrashedError();
        for (const w of this.waiters.splice(0)) {
          if (w.timer) clearTimeout(w.timer);
          w.reject(this.exitError);
        }
        resolve();
      };
      this.child.on("exit", () => onGone());
      this.child.on("error", (err) => onGone(new EngineCrashedError(`Could not start engine: ${err.message}`)));
    });
  }

  get alive(): boolean {
    return this.exitError === null;
  }

  send(line: string): void {
    if (!this.alive) throw this.exitError ?? new EngineCrashedError();
    this.child.stdin.write(`${line}\n`);
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolve with the first subsequent line matching `predicate`. */
  waitFor(predicate: (line: string) => boolean, timeoutMs = 30_000): Promise<string> {
    if (!this.alive) return Promise.reject(this.exitError ?? new EngineCrashedError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { predicate, resolve, reject, timer: null };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("Timed out waiting for the engine to respond."));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  kill(): void {
    if (this.alive) this.child.kill();
  }

  async quit(command: string): Promise<void> {
    if (!this.alive) return;
    try {
      this.send(command);
    } catch {
      // already gone
    }
    const timer = setTimeout(() => this.child.kill(), 1500);
    await this.exited;
    clearTimeout(timer);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      for (const l of this.listeners) l(line);
      for (const w of [...this.waiters]) {
        if (w.predicate(line)) {
          this.waiters = this.waiters.filter((x) => x !== w);
          if (w.timer) clearTimeout(w.timer);
          w.resolve(line);
        }
      }
    }
  }
}
