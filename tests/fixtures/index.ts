import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixturePgn(name: string): string {
  return fs.readFileSync(path.join(here, "pgn", `${name}.pgn`), "utf8");
}

export function fixtureJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(here, `${name}.json`), "utf8")) as T;
}
