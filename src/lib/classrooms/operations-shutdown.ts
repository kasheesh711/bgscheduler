import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { classroomPublishJobs as jobs, classroomPublishWorker as worker } from "@/lib/db/schema";
import { CLASSROOM_OPERATIONS_OWNER, CLASSROOM_SHUTDOWN_REASON } from "./operations-policy";

/** Preserve evidence while fencing old workers out of all subsequent writes. Idempotent. */
export async function stopNonOwnerClassroomPublications(db: Database, jobId?: string) {
  return withDatabaseTransaction(db, async tx => {
    // Same lock ordering as claimPublishAttempt: global worker, then publication jobs.
    await tx.insert(worker).values({ id: "global" }).onConflictDoNothing();
    await tx.select().from(worker).where(eq(worker.id, "global")).for("update");
    const now = new Date();
    const stopped = await tx.update(jobs).set({
      status: "failed", lastError: CLASSROOM_SHUTDOWN_REASON, finishedAt: now, updatedAt: now,
      claimToken: null, leaseExpiresAt: null,
    }).where(and(
      inArray(jobs.status, ["pending", "running"]),
      sql`lower(btrim(coalesce(${jobs.createdBy}, ''))) <> ${CLASSROOM_OPERATIONS_OWNER}`,
      jobId ? eq(jobs.id, jobId) : undefined,
    )).returning({ id: jobs.id, runId: jobs.runId });
    if (stopped.length) {
      await tx.update(worker).set({ jobId: null, claimToken: null, leaseExpiresAt: null })
        .where(and(eq(worker.id, "global"), inArray(worker.jobId, stopped.map(job => job.id))));
    }
    return stopped;
  });
}
