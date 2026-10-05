// Thin client for the local ChessAnalyser API. The token comes from the page itself (injected by
// the backend); it is never fetched from an endpoint.

const TOKEN_PLACEHOLDER = "%CHESSANALYSER_TOKEN%";

export function sessionToken(): string | null {
  const t = document.querySelector<HTMLMetaElement>('meta[name="chessanalyser-token"]')?.content ?? "";
  return t && t !== TOKEN_PLACEHOLDER ? t : null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let reloading = false;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = sessionToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, "OFFLINE", "ChessAnalyser's local server is not responding. Is `npm run dev` still running?");
  }
  if (res.status === 401 && !reloading) {
    // The backend restarted with a new session token; reload to pick it up.
    reloading = true;
    window.location.reload();
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) throw new ApiError(res.status, data.error?.code ?? "ERROR", data.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
