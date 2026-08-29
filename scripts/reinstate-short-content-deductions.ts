/**
 * INC-260829 re-charge: reinstate the genuinely-short classes the incident
 * remediation waived.
 *
 * Scope: deductions waived by the remediation (`inc-260829:waive:%` action
 * keys) whose latest assessment shows combined feedback under the
 * 300-character bar — valid deductions under both the old and the new content
 * policy, forgiven only because the auto-approval incident meant no human had
 * reviewed them. Each is moved `waived → pending_review` through the
 * `reinstate` review action (which refuses while any written ledger row is
 * still live — run the retirement backfill first). Admins then approve each
 * one in the Class Feedback UI; the next deliberate publish appends fresh
 * generation-2 −฿100 rows.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/reinstate-short-content-deductions.ts
 *   ... --commit --actor=you@example.com
 */

import path from "node:path";

import { eq, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { applyPostClassReviewAction } from "@/lib/post-class-feedback/actions";
import { POST_CLASS_MIN_COMBINED_CHARACTERS } from "@/lib/post-class-feedback/policy";

import {
  loadPayoutScriptEnvironment,
  writeJsonArtifactExclusive,
} from "./lib/payout-script";

const REINSTATE_NOTE =
  "Re-charged after INC-260829: content below the 300-character minimum; "
  + "the waiver applied only for the missing human review.";

interface Candidate {
  deductionId: string;
  version: number;
  wiseSessionId: string;
  tutorName: string | null;
  combinedRawCharCount: number;
}

async function planReinstatements(db: Database): Promise<Candidate[]> {
  const rows = await db.execute(sql`
    with remediated as (
      select d.id, d.version, d.session_id
      from post_class_deductions d
      join post_class_deduction_actions a on a.deduction_id = d.id
      where a.idempotency_key like ${"inc-260829:waive:%"}
        and d.status = 'waived'
    ), latest as (
      select distinct on (x.session_id)
        x.session_id, x.combined_raw_char_count
      from post_class_assessments x
      join remediated r on r.session_id = x.session_id
      order by x.session_id, x.assessed_at desc
    )
    select r.id as deduction_id, r.version, s.wise_session_id, s.canonical_tutor_name,
           l.combined_raw_char_count
    from remediated r
    join post_class_sessions s on s.id = r.session_id
    join latest l on l.session_id = r.session_id
    where l.combined_raw_char_count < ${POST_CLASS_MIN_COMBINED_CHARACTERS}
    order by s.canonical_tutor_name, s.scheduled_end_at
  `);
  return (rows.rows as Array<Record<string, unknown>>).map((row) => ({
    deductionId: String(row.deduction_id),
    version: Number(row.version),
    wiseSessionId: String(row.wise_session_id),
    tutorName: row.canonical_tutor_name === null ? null : String(row.canonical_tutor_name),
    combinedRawCharCount: Number(row.combined_raw_char_count),
  }));
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npx tsx --tsconfig scripts/tsconfig.json "
      + "scripts/reinstate-short-content-deductions.ts [--commit --actor=you@example.com]",
    );
    return;
  }
  loadPayoutScriptEnvironment();
  const commit = process.argv.includes("--commit");
  const actorArg = process.argv.find((arg) => arg.startsWith("--actor="));
  const actorEmail = actorArg?.slice("--actor=".length).trim() ?? "";
  if (commit && !actorEmail.includes("@")) {
    throw new Error("--commit requires --actor=<your email>; the reinstate is attributed to it.");
  }
  const db = getDb();
  console.log(commit ? "Mode: COMMIT\n" : "Mode: dry run (pass --commit --actor=... to apply)\n");

  const plan = await planReinstatements(db);
  for (const candidate of plan) {
    console.log(
      `  reinstate  ${candidate.tutorName ?? "(unnamed)"}  ${candidate.wiseSessionId}`
      + `  ${candidate.combinedRawCharCount}/${POST_CLASS_MIN_COMBINED_CHARACTERS} chars`,
    );
  }
  console.log(`\nPlanned: ${plan.length} deductions back to pending_review for admin approval.`);
  if (!commit || plan.length === 0) return;

  writeJsonArtifactExclusive(
    path.resolve(
      ".payout-ops",
      `inc-260829-reinstate-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
    ),
    {
      kind: "inc-260829-reinstate-short-content",
      plannedAt: new Date().toISOString(),
      actorEmail,
      note: REINSTATE_NOTE,
      items: plan,
    },
  );

  const actor = { email: actorEmail, name: "INC-260829 re-charge" };
  let reinstated = 0;
  let failed = 0;
  for (const candidate of plan) {
    try {
      const [current] = await db.select({
        version: schema.postClassDeductions.version,
        status: schema.postClassDeductions.status,
      }).from(schema.postClassDeductions)
        .where(eq(schema.postClassDeductions.id, candidate.deductionId)).limit(1);
      if (!current || current.status !== "waived") {
        console.log(`  skip   ${candidate.wiseSessionId}  no longer waived`);
        continue;
      }
      await applyPostClassReviewAction(actor, {
        deductionId: candidate.deductionId,
        action: "reinstate",
        note: REINSTATE_NOTE,
        expectedVersion: current.version,
        idempotencyKey: `inc-260829:reinstate:${candidate.deductionId}`,
      }, db);
      reinstated += 1;
    } catch (error) {
      console.error(`  FAIL   ${candidate.wiseSessionId}`, error instanceof Error ? error.message : error);
      failed += 1;
    }
  }
  console.log(`\nApplied: ${reinstated} reinstated, ${failed} failed.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
