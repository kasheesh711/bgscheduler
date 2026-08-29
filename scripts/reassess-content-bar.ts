/**
 * Retroactive reassessment under the char-count content bar (2026-08-29).
 *
 * Replays every eligible, source-ready session's stored evidence through the
 * current policy. Sessions whose verdict clears (timing or content) get a new
 * assessment row; their open, unwritten deduction is waived by
 * `system:post-class-reassess` with a reason-scoped note. Written deductions
 * are never touched here (see reassess.ts).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/reassess-content-bar.ts
 *   ... --commit   apply (default is a dry run)
 */

import path from "node:path";

import { reassessPostClassSessions } from "@/lib/post-class-feedback/reassess";

import {
  loadPayoutScriptEnvironment,
  writeJsonArtifactExclusive,
} from "./lib/payout-script";

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npx tsx --tsconfig scripts/tsconfig.json scripts/reassess-content-bar.ts [--commit]",
    );
    return;
  }
  loadPayoutScriptEnvironment();
  const commit = process.argv.includes("--commit");
  console.log(commit ? "Mode: COMMIT\n" : "Mode: dry run (pass --commit to apply)\n");

  const result = await reassessPostClassSessions({
    timingStatuses: ["late", "on_time", "unknown"],
    apply: commit,
  });

  const interesting = result.outcomes.filter((outcome) => outcome.changed);
  for (const outcome of interesting) {
    console.log(
      `  ${outcome.cleared ?? "timing-flip"}  ${outcome.canonicalTutorName ?? "(unnamed)"}`
      + `  ${outcome.wiseSessionId}  ${outcome.from} -> ${outcome.to}`
      + `${outcome.deductionWaived ? "  [deduction waived]" : ""}`,
    );
  }
  const tally = {
    scanned: result.scanned,
    changed: result.changed,
    clearedContent: interesting.filter((outcome) => outcome.cleared === "content").length,
    clearedTiming: interesting.filter((outcome) => outcome.cleared === "timing").length,
    deductionsWaived: result.deductionsWaived,
    failed: result.failed,
  };
  console.log(`\n${JSON.stringify(tally, null, 2)}`);

  if (interesting.length > 0) {
    writeJsonArtifactExclusive(
      path.resolve(
        ".payout-ops",
        `content-bar-reassess-${commit ? "commit" : "dry-run"}-`
        + `${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
      ),
      {
        kind: "content-bar-reassess",
        mode: commit ? "commit" : "dry-run",
        ranAt: new Date().toISOString(),
        tally,
        outcomes: interesting.map((outcome) => ({
          ...outcome,
          deadlineAt: outcome.deadlineAt.toISOString(),
          provenAt: outcome.provenAt?.toISOString() ?? null,
        })),
      },
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
