import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataPaths } from "./paths";

/** Local session credential shared with the MCP process (spec §52). Never logged. */
export interface SessionFile {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  origin: string;
}

/** Create the data directory readable only by the current user. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

/**
 * Write a file that only the current user can read. POSIX: mode 0600. Windows: %APPDATA% is already
 * per-user; we additionally strip inherited ACLs and grant only the current user.
 */
export function writePrivateFile(file: string, contents: string): { warning?: string } {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
    return {};
  }
  try {
    const user = process.env.USERNAME ?? os.userInfo().username;
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
    return {};
  } catch {
    return { warning: "Could not restrict session file ACL; relying on %APPDATA% per-user permissions." };
  }
}

export function writeSessionFile(session: SessionFile): { warning?: string } {
  return writePrivateFile(dataPaths.session(), JSON.stringify(session, null, 2));
}

export function readSessionFile(): SessionFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPaths.session(), "utf8")) as SessionFile;
    if (typeof parsed.port !== "number" || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function removeSessionFile(pid: number): void {
  const current = readSessionFile();
  if (current && current.pid === pid) {
    try {
      fs.unlinkSync(dataPaths.session());
    } catch {
      // already gone
    }
  }
}
