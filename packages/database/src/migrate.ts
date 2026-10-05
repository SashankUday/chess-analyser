import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transaction, type Database } from "./sqlite";

export interface AppliedMigration {
  version: number;
  name: string;
}

/**
 * Locate the SQL migrations directory both when running from source (packages/database/src) and from
 * the bundled server (apps/server/dist, which copies migrations next to itself).
 */
export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "..", "migrations"), path.join(here, "migrations")];
  const found = candidates.find((dir) => fs.existsSync(dir));
  if (!found) throw new Error(`Database migrations not found (looked in ${candidates.join(", ")})`);
  return found;
}

/** Apply numbered `NNN_name.sql` migrations in order, each in its own transaction (spec §35). */
export function migrate(db: Database, dir = defaultMigrationsDir()): AppliedMigration[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();

  const newlyApplied: AppliedMigration[] = [];
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    transaction(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        version,
        file,
        new Date().toISOString(),
      );
    });
    newlyApplied.push({ version, name: file });
  }
  return newlyApplied;
}
