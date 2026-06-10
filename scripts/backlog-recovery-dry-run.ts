import { loadEnvConfig } from "@next/env";
import { writeFileSync } from "node:fs";
import { getDb } from "@/lib/db";
import { runLineBacklogRecovery } from "@/lib/line/backlog-recovery";

loadEnvConfig(process.cwd());

async function main() {
  const live = process.argv.includes("--live");
  const db = getDb();
  const result = await runLineBacklogRecovery({ db, dryRun: !live });

  const matches = result.dryRunMatches ?? [];
  const high = matches.filter((m) => m.confidence === "high");
  const ambiguous = matches.filter((m) => m.confidence === "ambiguous");
  const withUrl = matches.filter(
    (m) => m.lineChatUrl?.startsWith("https://chat.line.biz/"),
  );

  writeFileSync(
    live ? "/tmp/12-04-live.json" : "/tmp/12-04-dryrun.json",
    JSON.stringify(result, null, 2),
  );

  console.log(
    JSON.stringify(
      {
        contactsScanned: result.contactsScanned,
        targetsCount: result.targetsCount,
        matchedCount: result.matchedCount,
        insertedCount: result.insertedCount,
        dryRun: result.dryRun,
        highConfidence: high.length,
        ambiguous: ambiguous.length,
        withChatLineBizUrl: withUrl.length,
      },
      null,
      2,
    ),
  );
  console.log("--- sample (first 15 high-confidence) ---");
  for (const m of high.slice(0, 15)) {
    console.log(
      `${m.confidence}  ${m.displayName}  ->  ${m.studentName}  [${m.tokens.join(",")}]  ${m.lineChatUrl ?? "NO-URL"}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
