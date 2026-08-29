/**
 * INC-260829: mark the 2026-08 run's queued payout corrections `superseded`.
 *
 * The admin corrected the master ledger by hand, so the +฿100 waiver
 * adjustments queued by the remediation must never be appended by any pass —
 * scheduled or manual. `superseded` is terminal: excluded from append
 * planning and satisfied for run-close readiness (see payout-run.ts /
 * payout-repository.ts).
 *
 * This intentionally bypasses `markPayoutAdjustment` (which requires a live
 * publish lease) — no publish is running and none should be. The update is a
 * guarded direct write under the finance lock: only `waiver` adjustments of
 * the target anchor month currently `pending` or `failed` are touched.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/supersede-inc-260829-adjustments.ts
 *   ... --commit   apply (default is a dry run)
 */

import path from "node:path";

import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { lockPostClassFinance } from "@/lib/post-class-feedback/finance-lock";
import { withPostClassTransaction } from "@/lib/post-class-feedback/transaction";

import {
  loadPayoutScriptEnvironment,
  writeJsonArtifactExclusive,
} from "./lib/payout-script";

const TARGET_ANCHOR_MONTH = "2026-08-01";
const SUPERSEDE_NOTE =
  "Applied manually on the master sheet by the admin (INC-260829); system append superseded.";

interface CandidateAdjustment {
  id: string;
  deductionId: string;
  status: string;
  reason: string;
  writeError: string | null;
  createdAt: Date;
  fromIncidentRemediation: boolean;
}

async function planSupersede(db: Database): Promise<CandidateAdjustment[]> {
  const [run] = await db.select({ id: schema.postClassPayoutRuns.id })
    .from(schema.postClassPayoutRuns)
    .where(eq(schema.postClassPayoutRuns.anchorMonth, TARGET_ANCHOR_MONTH))
    .limit(1);
  if (!run) throw new Error(`No payout run found for anchor ${TARGET_ANCHOR_MONTH}.`);

  const rows = await db.select({
    id: schema.postClassPayoutAdjustments.id,
    deductionId: schema.postClassPayoutAdjustments.deductionId,
    status: schema.postClassPayoutAdjustments.status,
    reason: schema.postClassPayoutAdjustments.reason,
    writeError: schema.postClassPayoutAdjustments.writeError,
    createdAt: schema.postClassPayoutAdjustments.createdAt,
    idempotencyKey: schema.postClassPayoutAdjustments.idempotencyKey,
  }).from(schema.postClassPayoutAdjustments)
    .leftJoin(
      schema.postClassPayoutRunLines,
      eq(schema.postClassPayoutAdjustments.sourceLineId, schema.postClassPayoutRunLines.id),
    )
    .where(and(
      eq(schema.postClassPayoutAdjustments.kind, "waiver"),
      inArray(schema.postClassPayoutAdjustments.status, ["pending", "failed"]),
      or(
        eq(schema.postClassPayoutAdjustments.runId, run.id),
        isNull(schema.postClassPayoutAdjustments.runId),
        eq(schema.postClassPayoutRunLines.runId, run.id),
      ),
    ))
    .orderBy(schema.postClassPayoutAdjustments.createdAt);

  return rows.map((row) => ({
    id: row.id,
    deductionId: row.deductionId,
    status: row.status,
    reason: row.reason,
    writeError: row.writeError,
    createdAt: row.createdAt,
    fromIncidentRemediation: row.idempotencyKey.includes("inc-260829"),
  }));
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npx tsx --tsconfig scripts/tsconfig.json "
      + "scripts/supersede-inc-260829-adjustments.ts [--commit]",
    );
    return;
  }
  loadPayoutScriptEnvironment();
  const commit = process.argv.includes("--commit");
  const db = getDb();
  console.log(commit ? "Mode: COMMIT\n" : "Mode: dry run (pass --commit to apply)\n");

  const plan = await planSupersede(db);
  for (const item of plan) {
    console.log(
      `  supersede  ${item.status.padEnd(7)} ${item.id}`
      + `${item.fromIncidentRemediation ? "" : "  [pre-incident waiver — review]"}`,
    );
  }
  const preIncident = plan.filter((item) => !item.fromIncidentRemediation).length;
  console.log(
    `\nPlanned: ${plan.length} adjustments → superseded`
    + ` (${plan.length - preIncident} from the INC-260829 remediation, ${preIncident} pre-incident).`,
  );
  if (plan.length === 0 || !commit) return;

  writeJsonArtifactExclusive(
    path.resolve(
      ".payout-ops",
      `inc-260829-supersede-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
    ),
    {
      kind: "inc-260829-supersede-adjustments",
      plannedAt: new Date().toISOString(),
      note: SUPERSEDE_NOTE,
      items: plan.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
    },
  );

  const updated = await withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    let count = 0;
    for (const item of plan) {
      const [row] = await tx.update(schema.postClassPayoutAdjustments).set({
        status: "superseded",
        writeError: SUPERSEDE_NOTE,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.postClassPayoutAdjustments.id, item.id),
        inArray(schema.postClassPayoutAdjustments.status, ["pending", "failed"]),
      )).returning({ id: schema.postClassPayoutAdjustments.id });
      if (row) count += 1;
    }
    return count;
  });
  console.log(`Superseded ${updated} adjustment${updated === 1 ? "" : "s"}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
