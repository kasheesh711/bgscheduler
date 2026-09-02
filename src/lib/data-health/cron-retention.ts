// Retention for cron_invocations — the append-only audit ledger every cron
// route writes two rows to (start + finish). Nothing ever pruned it, so it
// grows without bound while Data Health only ever reads the newest
// INVOCATIONS_PER_JOB rows per job.
//
// The sweep is deliberately conservative: a row is only removed once it is
// BOTH older than the retention horizon AND already outside the per-job read
// window, so a job that fires once a year keeps its proof forever.

import { and, gt, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { INVOCATIONS_PER_JOB } from "./dashboard";

/** Age past which an invocation is eligible for deletion. */
export const CRON_INVOCATION_RETENTION_DAYS = 90;

/** UTC instant before which invocations are eligible for deletion. */
export function cronInvocationRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - CRON_INVOCATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Delete `cron_invocations` rows older than the retention horizon that are not
 * among the newest {@link INVOCATIONS_PER_JOB} rows for their `job_key`.
 *
 * One statement: a `row_number()` window ranks every row per job, and the
 * DELETE targets the ids that fail both guards.
 *
 * @returns the number of rows deleted.
 */
export async function pruneCronInvocations(db: Database, now = new Date()): Promise<number> {
  const cutoff = cronInvocationRetentionCutoff(now);

  const ranked = db
    .select({
      id: schema.cronInvocations.id,
      receivedAt: schema.cronInvocations.receivedAt,
      rowNumber: sql<number>`row_number() over (partition by ${schema.cronInvocations.jobKey} order by ${schema.cronInvocations.receivedAt} desc)`.as("row_number"),
    })
    .from(schema.cronInvocations)
    .as("ranked");

  const expired = db
    .select({ id: ranked.id })
    .from(ranked)
    .where(and(gt(ranked.rowNumber, INVOCATIONS_PER_JOB), lt(ranked.receivedAt, cutoff)));

  const deleted = await db
    .delete(schema.cronInvocations)
    .where(inArray(schema.cronInvocations.id, expired))
    .returning({ id: schema.cronInvocations.id });

  return deleted.length;
}
