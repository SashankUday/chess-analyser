// Managed Stockfish installation (spec §16–17): download → verify SHA-256 → extract → chmod →
// UCI handshake → confirm identity → atomic install. An unverified download is never executed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";
import * as tar from "tar";
import { APP_NAME, APP_VERSION } from "@chessanalyser/shared";
import { dataPaths } from "@chessanalyser/shared/node";
import manifestJson from "../../../engine-manifest.json" with { type: "json" };
import { probeUci, sha256File } from "./stockfish";

export interface ManifestPlatform {
  url: string;
  sha256: string;
  archive: "tar.gz" | "zip";
  binary: string;
}

export interface EngineManifest {
  stockfish: { version: string; release: string; source: string; platforms: Record<string, ManifestPlatform> };
}

export const engineManifest = manifestJson as EngineManifest;

export interface InstallRecord {
  version: string;
  binary: string;
  binarySha256: string;
  archiveSha256: string;
  url: string;
  installedAt: string;
}

export class InstallError extends Error {
  constructor(
    message: string,
    readonly kind: "unsupported_platform" | "download" | "checksum" | "extract" | "handshake",
  ) {
    super(message);
    this.name = "InstallError";
  }
}

export function platformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

export function manifestEntry(key = platformKey()): ManifestPlatform | null {
  return engineManifest.stockfish.platforms[key] ?? null;
}

export function managedInstallDir(version = engineManifest.stockfish.version): string {
  return dataPaths.managedStockfishDir(version);
}

/** The existing managed install, if its record and binary are intact. */
export function readManagedInstall(version = engineManifest.stockfish.version): InstallRecord | null {
  try {
    const dir = managedInstallDir(version);
    const record = JSON.parse(fs.readFileSync(path.join(dir, "install.json"), "utf8")) as InstallRecord;
    const binary = path.join(dir, record.binary);
    if (!fs.existsSync(binary)) return null;
    return { ...record, binary };
  } catch {
    return null;
  }
}

export interface InstallProgress {
  stage: "download" | "verify" | "extract" | "handshake" | "done";
  message: string;
  /** 0–1 during download when the size is known. */
  fraction?: number;
}

export async function installStockfish(
  onProgress: (p: InstallProgress) => void = () => undefined,
  options: { fetchImpl?: typeof fetch; entry?: ManifestPlatform } = {},
): Promise<InstallRecord> {
  const entry = options.entry ?? manifestEntry();
  const version = engineManifest.stockfish.version;
  if (!entry) {
    throw new InstallError(`No Stockfish ${version} build is listed for ${platformKey()}.`, "unsupported_platform");
  }
  const enginesDir = dataPaths.engines();
  fs.mkdirSync(enginesDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(enginesDir, ".install-"));
  try {
    // 1. Download while hashing.
    const archivePath = path.join(work, `stockfish.${entry.archive}`);
    onProgress({ stage: "download", message: `Downloading Stockfish ${version}...`, fraction: 0 });
    const archiveSha256 = await download(entry.url, archivePath, options.fetchImpl ?? fetch, (fraction) =>
      onProgress({ stage: "download", message: `Downloading Stockfish ${version}...`, fraction }),
    );

    // 2. Verify before anything is extracted or executed.
    onProgress({ stage: "verify", message: "Checking integrity..." });
    if (archiveSha256 !== entry.sha256.toLowerCase()) {
      throw new InstallError(
        `Integrity check failed: expected SHA-256 ${entry.sha256}, got ${archiveSha256}. The download was discarded.`,
        "checksum",
      );
    }

    // 3. Extract and locate the executable.
    onProgress({ stage: "extract", message: "Extracting..." });
    const extractDir = path.join(work, "extract");
    fs.mkdirSync(extractDir);
    try {
      if (entry.archive === "zip") new AdmZip(archivePath).extractAllTo(extractDir, true);
      else await tar.x({ file: archivePath, cwd: extractDir });
    } catch (err) {
      throw new InstallError(`Could not extract the Stockfish archive: ${(err as Error).message}`, "extract");
    }
    const extractedBinary = locateBinary(extractDir, entry.binary);
    if (!extractedBinary) throw new InstallError("The Stockfish archive did not contain an engine binary.", "extract");

    // 4. Stage the install.
    const staging = path.join(work, "staging");
    fs.mkdirSync(staging);
    const binaryName = process.platform === "win32" ? "stockfish.exe" : "stockfish";
    const stagedBinary = path.join(staging, binaryName);
    fs.copyFileSync(extractedBinary, stagedBinary);
    if (process.platform !== "win32") fs.chmodSync(stagedBinary, 0o755);
    const licence = path.join(path.dirname(extractedBinary), "Copying.txt");
    if (fs.existsSync(licence)) fs.copyFileSync(licence, path.join(staging, "Copying.txt"));

    // 5. Launch, `uci`, confirm identity.
    onProgress({ stage: "handshake", message: "Confirming engine identity..." });
    let probe: Awaited<ReturnType<typeof probeUci>>;
    try {
      probe = await probeUci(stagedBinary);
    } catch (err) {
      throw new InstallError(`The downloaded engine did not start: ${(err as Error).message}`, "handshake");
    }
    if (!/^Stockfish\b/i.test(probe.name) || probe.version !== version) {
      throw new InstallError(`Expected Stockfish ${version} but the engine reported "${probe.name}".`, "handshake");
    }

    const record: InstallRecord = {
      version,
      binary: binaryName,
      binarySha256: sha256File(stagedBinary),
      archiveSha256,
      url: entry.url,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(staging, "install.json"), JSON.stringify(record, null, 2));

    // 6. Atomic swap into place.
    const finalDir = managedInstallDir(version);
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    const old = `${finalDir}.old-${process.pid}`;
    if (fs.existsSync(finalDir)) fs.renameSync(finalDir, old);
    fs.renameSync(staging, finalDir);
    fs.rmSync(old, { recursive: true, force: true });

    onProgress({ stage: "done", message: `Stockfish ${version} installed.` });
    return { ...record, binary: path.join(finalDir, binaryName) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function download(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
  onFraction: (f: number) => void,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { "User-Agent": `${APP_NAME}/${APP_VERSION}` }, redirect: "follow" });
  } catch (err) {
    throw new InstallError(`Unable to download Stockfish: ${(err as Error).message}`, "download");
  }
  if (!res.ok || !res.body) throw new InstallError(`Unable to download Stockfish (HTTP ${res.status}).`, "download");
  const total = Number(res.headers.get("content-length") ?? 0);
  const hash = crypto.createHash("sha256");
  let received = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    if (total && received - lastReport > total / 50) {
      lastReport = received;
      onFraction(received / total);
    }
  });
  try {
    await pipeline(body, fs.createWriteStream(dest));
  } catch (err) {
    throw new InstallError(`Unable to download Stockfish: ${(err as Error).message}`, "download");
  }
  return hash.digest("hex");
}

/** Prefer the manifest path; otherwise the first `stockfish-*` file outside the source tree. */
function locateBinary(root: string, expected: string): string | null {
  const direct = path.join(root, expected);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["src", "wiki", "scripts", "tests"].includes(entry.name)) stack.push(full);
      } else if (/^stockfish[-_].*?(\.exe)?$/i.test(entry.name) && !/\.(txt|md|sh|cff)$/i.test(entry.name)) {
        return full;
      }
    }
  }
  return null;
}
