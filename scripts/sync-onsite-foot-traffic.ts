import { loadEnvConfig } from "@next/env";

import { getDb } from "@/lib/db";
import { runOnsiteFootTrafficSync } from "@/lib/onsite-foot-traffic/sync";

loadEnvConfig(process.cwd());

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  const candidate = index >= 0 ? process.argv[index + 1] : undefined;
  return candidate && !candidate.startsWith("--") ? candidate : undefined;
}

async function main(): Promise<void> {
  const mode = arg("mode") ?? "backfill";
  if (mode !== "backfill" && mode !== "rolling") {
    throw new Error("--mode must be backfill or rolling");
  }
  const result = await runOnsiteFootTrafficSync(getDb(), {
    mode,
    startDate: arg("start-date"),
    endDate: arg("end-date"),
    triggerType: "cli",
    actorEmail: process.env.FOOT_TRAFFIC_BACKFILL_ACTOR_EMAIL ?? null,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
