// Node's built-in SQLite (node:sqlite) — no native add-on to compile, so `npm install` works on every
// platform without a C++ toolchain.
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";

const require = createRequire(import.meta.url);

/** Load node:sqlite, silencing only its "experimental feature" warning. */
function loadSqlite(): typeof NodeSqlite {
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (message?.includes("SQLite is an experimental feature")) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof NodeSqlite;
  } finally {
    process.emitWarning = original;
  }
}

export const { DatabaseSync } = loadSqlite();
export type Database = NodeSqlite.DatabaseSync;
export type SqlValue = NodeSqlite.SQLInputValue;

/** Run `fn` inside a transaction; rolls back if it throws. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
