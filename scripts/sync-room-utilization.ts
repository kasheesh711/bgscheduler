import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";
import { syncRoomUtilizationSessions } from "@/lib/room-capacity/utilization";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnvFile(path.resolve(process.cwd(), ".env.local"));

  const startDate = optionValue("--start-date");
  const result = await syncRoomUtilizationSessions(getDb(), { startDate });
  console.log(`Fetched Wise sessions: ${result.fetchedCount}`);
  console.log(`Stored room-utilization sessions from ${result.startDate}: ${result.storedCount}`);
  console.log(`Synced at: ${result.syncedAt}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
