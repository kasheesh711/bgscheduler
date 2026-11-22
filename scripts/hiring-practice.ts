import { parseArgs } from "node:util";
import { emailSchema } from "../src/lib/hiring/model";
import { runHiringPractice } from "../src/lib/hiring/practice";

async function main() {
  const { values } = parseArgs({
    options: { apply: { type: "boolean" }, remove: { type: "boolean" }, email: { type: "string" } },
  });
  if (values.apply && process.env.HIRING_PRACTICE_CONFIRM !== "yes")
    throw new Error("Set HIRING_PRACTICE_CONFIRM=yes to apply.");
  if ((values.apply || values.email !== undefined) && !emailSchema.safeParse(values.email).success)
    throw new Error("Supply a valid --email address. Practice candidates need unique plus aliases.");
  const rows = await runHiringPractice(values);
  console.log(JSON.stringify({ dryRun: !values.apply, operation: values.remove ? "delete" : "insert", rows }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Practice candidate operation failed.");
  process.exitCode = 1;
});
