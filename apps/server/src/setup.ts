// `npm run setup`: install/verify the engine explicitly, with readable progress (spec §3, §75).
import { ensureEngine } from "@chessanalyser/engine";
import { APP_NAME } from "@chessanalyser/shared";
import { dataPaths } from "@chessanalyser/shared/node";

console.log(`${APP_NAME}\n\nChecking engine...`);
let lastMessage = "";
const result = await ensureEngine({
  onStatus: (s) => {
    if (s.state === "installing") {
      const pct = s.progress !== undefined ? ` ${Math.round(s.progress * 100)}%` : "";
      const line = `${s.message}${pct}`;
      if (line !== lastMessage) process.stdout.write(`\r${line.padEnd(60)}`);
      lastMessage = line;
    }
  },
  log: (level, message) => level === "warn" && console.warn(`\n${message}`),
});
process.stdout.write("\n");

if (result.status.state === "ready") {
  console.log(`✓ ${result.status.name} ready (${result.status.source})`);
  if (result.status.fallback) {
    console.log("Stockfish is currently unavailable; using the Apple Chess fallback. Some review features are reduced.");
  }
  console.log(`Engine files: ${dataPaths.engines()}`);
  await result.engine?.dispose();
} else {
  console.error(`✗ ${result.status.state === "unavailable" ? result.status.error : "No engine available."}`);
  process.exitCode = 1;
}
