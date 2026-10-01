import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { getDb } from "@/lib/db";
import { syncWorkforceHistory } from "@/lib/tutor-offboarding/workforce/source-sync";

loadEnvConfig(process.cwd());

function arg(name: string): string | undefined {
  const inline = process.argv.find(item => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}
function required(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}
function positiveInt(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

async function main(): Promise<void> {
  const from = required("from"), to = required("to");
  const checkpointPath = path.resolve(arg("checkpoint") ?? path.join(process.cwd(), ".tutor-offboarding/workforce-checkpoints", `${from}_${to}.json`));
  const apply = process.argv.includes("--apply");
  const result = await syncWorkforceHistory({
    from, to, maxRequests: positiveInt("max-requests"), maxPages: positiveInt("max-pages"),
    checkpointPath, mode: apply ? "apply" : "dry_run",
    sessionsOnly: process.argv.includes("--sessions-only"),
    refreshCredits: process.argv.includes("--refresh-credits"),
  }, apply ? { db: getDb() } : {});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.complete || (process.argv.includes("--refresh-credits") && !result.creditsComplete)) process.exitCode = 2;
}

main().catch(error => {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message.split("(")[0].trim() : "Sync failed";
  process.stderr.write(`${name}: ${message}\n`);
  process.exitCode = 1;
});
