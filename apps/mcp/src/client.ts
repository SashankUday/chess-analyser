import { readSessionFile } from "@chessanalyser/shared/node";

export const NOT_RUNNING = "ChessAnalyser is not currently running.\nStart it with npm run dev.";

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thin HTTP client for the local ChessAnalyser API. The session credential is re-read on every call
 * so a restarted app (new port, new token) is picked up without restarting the MCP process.
 */
export async function callApp(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const session = readSessionFile();
  if (!session) throw new AppError("NOT_RUNNING", NOT_RUNNING);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${session.port}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new AppError("NOT_RUNNING", NOT_RUNNING);
  }
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { code: string; message: string } };
  if (!res.ok) {
    if (res.status === 401) throw new AppError("NOT_RUNNING", NOT_RUNNING);
    throw new AppError(body.error?.code ?? `HTTP_${res.status}`, body.error?.message ?? `Request failed (${res.status}).`);
  }
  return body;
}
