/**
 * Backfill `post_class_payout_run_lines.tutor_submitted_at` for lines written
 * while the submission subquery dropped NULL-autoSubmitted event links.
 *
 * Every human (non-auto) `SessionFeedbackSubmittedEvent` link in production
 * carries `auto_submitted = NULL`, so the pre-fix SQL (`<> true` / `= false`)
 * derived nothing and every written line stored a NULL submission time. The
 * derivation below is byte-identical to the corrected subquery in
 * `payout-repository.ts` (`IS DISTINCT FROM true`, no actor-role gate per
 * D-EVT-04), so backfilled values can never register as payload drift.
 *
 * Only NULL columns are filled — the script never overwrites a stored value
 * and is safe to re-run after new lines land.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/backfill-payout-tutor-submitted.ts
 *   ... --commit   write the derived values (default is a dry run)
 *
 * `--tsconfig` is required: this reaches server-only modules that plain tsx
 * cannot resolve. See `scripts/stubs/server-only.ts`.
 */

import path from "node:path";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { lockPostClassFinance } from "@/lib/post-class-feedback/finance-lock";
import { withPostClassTransaction } from "@/lib/post-class-feedback/transaction";

import {
  loadPayoutScriptEnvironment,
  writeJsonArtifactExclusive,
} from "./lib/payout-script";

function bangkok(value: Date): string {
  return value.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
}

interface BackfillPlan {
  updates: Array<{
    lineId: string;
    wiseSessionId: string;
    tutorName: string | null;
    submittedAt: Date;
  }>;
  skipped: Array<{
    lineId: string;
    wiseSessionId: string;
    tutorName: string | null;
    linkCount: number;
  }>;
}

async function planBackfill(db: Database): Promise<BackfillPlan> {
  const lines = await db.select({
    lineId: schema.postClassPayoutRunLines.id,
    sessionId: schema.postClassPayoutRunLines.sessionId,
    wiseSessionId: schema.postClassPayoutRunLines.wiseSessionId,
    tutorName: schema.postClassPayoutRunLines.tutorName,
  }).from(schema.postClassPayoutRunLines)
    .where(isNull(schema.postClassPayoutRunLines.tutorSubmittedAt))
    .orderBy(schema.postClassPayoutRunLines.createdAt);
  if (lines.length === 0) return { updates: [], skipped: [] };

  const sessionIds = [...new Set(lines.map((line) => line.sessionId))];
  const derived = await db.select({
    sessionId: schema.postClassFeedbackEventLinks.sessionId,
    submittedAt: sql<string | null>`min(${schema.postClassFeedbackEventLinks.eventTimestamp})`,
  }).from(schema.postClassFeedbackEventLinks)
    .innerJoin(
      schema.wiseActivityEvents,
      eq(
        schema.postClassFeedbackEventLinks.wiseActivityEventId,
        schema.wiseActivityEvents.id,
      ),
    )
    .where(and(
      inArray(schema.postClassFeedbackEventLinks.sessionId, sessionIds),
      sql`${schema.postClassFeedbackEventLinks.autoSubmitted} IS DISTINCT FROM true`,
    ))
    .groupBy(schema.postClassFeedbackEventLinks.sessionId);
  const derivedBySession = new Map(
    derived
      .filter((row) => row.submittedAt !== null)
      .map((row) => [row.sessionId, new Date(row.submittedAt as string)]),
  );

  // Link totals distinguish "only the Wise auto-submission exists" from a
  // session with no linked events at all when reporting the skips.
  const linkCounts = await db.select({
    sessionId: schema.postClassFeedbackEventLinks.sessionId,
    total: sql<number>`count(*)`,
  }).from(schema.postClassFeedbackEventLinks)
    .where(inArray(schema.postClassFeedbackEventLinks.sessionId, sessionIds))
    .groupBy(schema.postClassFeedbackEventLinks.sessionId);
  const linkCountBySession = new Map(
    linkCounts.map((row) => [row.sessionId, Number(row.total)]),
  );

  const plan: BackfillPlan = { updates: [], skipped: [] };
  for (const line of lines) {
    const submittedAt = derivedBySession.get(line.sessionId);
    if (submittedAt) {
      plan.updates.push({
        lineId: line.lineId,
        wiseSessionId: line.wiseSessionId,
        tutorName: line.tutorName,
        submittedAt,
      });
    } else {
      plan.skipped.push({
        lineId: line.lineId,
        wiseSessionId: line.wiseSessionId,
        tutorName: line.tutorName,
        linkCount: linkCountBySession.get(line.sessionId) ?? 0,
      });
    }
  }
  return plan;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: npm run payout:backfill-submitted -- [--commit]");
    return;
  }
  loadPayoutScriptEnvironment();

  const commit = process.argv.includes("--commit");
  const db = getDb();
  console.log(commit ? "Mode: COMMIT\n" : "Mode: dry run (pass --commit to write)\n");

  const preview = await planBackfill(db);
  for (const update of preview.updates) {
    console.log(
      `  fill  ${update.wiseSessionId}  ${update.tutorName ?? "(unnamed)"}`
      + `  -> ${bangkok(update.submittedAt)} Bangkok`,
    );
  }
  for (const skip of preview.skipped) {
    console.log(
      `  skip  ${skip.wiseSessionId}  ${skip.tutorName ?? "(unnamed)"}`
      + `  no non-auto submission event`
      + ` (${skip.linkCount} linked event${skip.linkCount === 1 ? "" : "s"}, all auto or none)`,
    );
  }
  console.log(
    `\n${preview.updates.length} line${preview.updates.length === 1 ? "" : "s"} to fill,`
    + ` ${preview.skipped.length} left NULL.`,
  );
  if (!commit || preview.updates.length === 0) return;

  const artifactPath = path.resolve(
    ".payout-ops",
    `backfill-tutor-submitted-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
  );
  writeJsonArtifactExclusive(artifactPath, {
    kind: "backfill-payout-tutor-submitted",
    plannedAt: new Date().toISOString(),
    updates: preview.updates.map((update) => ({
      lineId: update.lineId,
      wiseSessionId: update.wiseSessionId,
      previousTutorSubmittedAt: null,
      newTutorSubmittedAt: update.submittedAt.toISOString(),
    })),
    skipped: preview.skipped,
  });
  console.log(`Backup artifact: ${artifactPath}`);

  const written = await withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    // Re-derive under the finance lock so a concurrent accrual pass cannot
    // slip a divergent value in between planning and writing.
    const plan = await planBackfill(tx);
    let count = 0;
    for (const update of plan.updates) {
      await tx.update(schema.postClassPayoutRunLines).set({
        tutorSubmittedAt: update.submittedAt,
        updatedAt: sql`now()`,
      }).where(and(
        eq(schema.postClassPayoutRunLines.id, update.lineId),
        isNull(schema.postClassPayoutRunLines.tutorSubmittedAt),
      ));
      count += 1;
    }
    return count;
  });
  console.log(`Updated ${written} line${written === 1 ? "" : "s"}.`);

  const [remaining] = await db.select({
    total: sql<number>`count(*)`,
    filled: sql<number>`count(${schema.postClassPayoutRunLines.tutorSubmittedAt})`,
  }).from(schema.postClassPayoutRunLines);
  console.log(
    `Verification: ${remaining.filled}/${remaining.total} lines now carry a submission time.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
