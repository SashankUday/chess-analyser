import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { dataPaths } from "@chessanalyser/shared/node";

const LEVELS: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };

/** Human-readable console lines; the log file keeps full JSON. */
function consoleStream(): Writable {
  return new Writable({
    write(chunk, _enc, done) {
      for (const raw of String(chunk).split("\n")) {
        if (!raw.trim()) continue;
        try {
          const { level, time, msg, component, ...rest } = JSON.parse(raw) as Record<string, unknown>;
          const t = new Date(Number(time)).toTimeString().slice(0, 8);
          const extras = Object.entries(rest)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(" ");
          const tag = component ? `[${component}] ` : "";
          process.stdout.write(`${t} ${LEVELS[Number(level)] ?? level} ${tag}${msg ?? ""}${extras ? `  ${extras}` : ""}\n`);
        } catch {
          process.stdout.write(`${raw}\n`);
        }
      }
      done();
    },
  });
}

/**
 * Local logs (spec §60): console plus a JSON file under the app-data directory. Tokens are redacted
 * and request bodies (which could contain LLM-originated text) are never logged.
 */
export function createLogger(level = process.env.CHESSANALYSER_LOG_LEVEL ?? "info") {
  const streams: pino.StreamEntry[] = [{ stream: consoleStream() }];
  if (process.env.CHESSANALYSER_LOG_FILE !== "0") {
    fs.mkdirSync(dataPaths.logs(), { recursive: true });
    streams.push({ stream: pino.destination({ dest: path.join(dataPaths.logs(), "chessanalyser.log"), mkdir: true, sync: false }) });
  }
  return pino(
    {
      level: level.toLowerCase(),
      base: undefined,
      redact: {
        paths: ["token", "*.token", "req.headers.authorization", 'req.headers["sec-websocket-protocol"]', "headers.authorization"],
        censor: "[redacted]",
      },
    },
    pino.multistream(streams),
  );
}

export type Logger = ReturnType<typeof createLogger>;
