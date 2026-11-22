import { parseArgs } from "node:util";
import { emailSchema, localDate } from "../src/lib/hiring/model";
import { runHiringPractice } from "../src/lib/hiring/practice";
import { briefExpiresAt } from "../src/lib/hiring/service";

async function main() {
  const { values } = parseArgs({
    options: { apply: { type: "boolean" }, remove: { type: "boolean" }, email: { type: "string" } },
  });
  if (values.apply && process.env.HIRING_PRACTICE_CONFIRM !== "yes")
    throw new Error("Set HIRING_PRACTICE_CONFIRM=yes to apply.");
  if (!values.remove && (values.apply || values.email !== undefined) && !emailSchema.safeParse(values.email).success)
    throw new Error("Supply a valid --email address. Practice candidates need unique plus aliases.");
  const { rows, summary } = await runHiringPractice(values);
  console.log(JSON.stringify({ dryRun: !values.apply, operation: values.remove ? "delete" : "insert", rows }, null, 2));
  const counts = { score: 0, "finished-no": 0, gift: 0, other: 0 };
  for (const { kind } of summary) counts[kind]++;
  console.log(`\nPractice candidates (${values.remove ? "remove" : "seed"}) — ${counts.score} to score, ${counts["finished-no"]} finished No, ${counts.gift} for Gift${counts.other ? `, ${counts.other} other` : ""}.`);
  for (const head of new Set(summary.map((entry) => entry.head))) {
    console.log(head ?? "Head unknown");
    for (const entry of summary.filter((item) => item.head === head)) {
      const expiry = entry.mockEnd ? ` (head link ends ${localDate(briefExpiresAt(entry.mockEnd))} Bangkok)` : "";
      console.log(`  ${entry.name}${expiry}`);
    }
  }
  console.log("Real taps send real messages: a head's No or Yes posts in the recruitment LINE group; a No, and Gift's decision, email the practice address with HR copied.");
  console.log("Gift's Yes sends an offer email with working links. Do not book the contract slot or complete the onboarding form from that email.");
  console.log("If hiring settings (weights, penalty, pass marks) change after seeding, Gift's packet shows 'Evidence changed': HR sends it again.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Practice candidate operation failed.");
  process.exitCode = 1;
});
