import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { classroomPublishJobs as jobs, classroomAssignmentRuns as runs } from "@/lib/db/schema";
import { runClassroomPublishJob } from "./data";

/** One bounded attempt per invocation; idle ticks do not call Wise. */
export async function runClassroomPublishRecovery(db: Database) {
  const now = new Date();
  // Pre-recovery jobs have no lease/fence and cannot safely be resumed. Preserve
  // their row evidence and close only attempts long past the old function limit.
  await db.update(jobs).set({ status: "failed", finishedAt: now, updatedAt: now,
    lastError: "Abandoned legacy publish attempt; publish the latest plan to retry",
  }).where(and(eq(jobs.status, "running"), sql`${jobs.leaseExpiresAt} is null`,
    sql`${jobs.startedAt} < ${now}::timestamptz - interval '15 minutes'`));
  const [job] = await db.select({ id: jobs.id }).from(jobs).innerJoin(runs, eq(runs.id, jobs.runId))
    .where(or(and(eq(jobs.status, "pending"), lte(jobs.nextAttemptAt, now)),
      and(eq(jobs.status, "running"), sql`coalesce(${jobs.leaseExpiresAt}, ${jobs.startedAt} + interval '15 minutes') < ${now}`)))
    .orderBy(asc(runs.assignmentDate), asc(jobs.createdAt)).limit(1);
  if (!job) return { ok: true, idle: true };
  const result = await runClassroomPublishJob(db, job.id);
  return { ok: !["failed", "partial"].includes(result.progress.status), idle: false, progress: result.progress };
}
