import type { ZodError } from "zod";

/** An error with an HTTP status and a stable machine-readable code. Messages are user-facing. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what: string) => new HttpError(404, "NOT_FOUND", `${what} not found.`);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, "BAD_REQUEST", message, details);

export function fromZod(err: ZodError): HttpError {
  const first = err.issues[0];
  const where = first?.path.length ? `${first.path.join(".")}: ` : "";
  return new HttpError(400, "INVALID_INPUT", `${where}${first?.message ?? "Invalid input."}`, err.issues);
}
