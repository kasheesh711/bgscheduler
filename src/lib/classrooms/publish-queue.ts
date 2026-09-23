import { isClassroomOperationsOwner, wiseClassroomAutomationEnabled } from "./operations-policy";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { classroomPublishJobs as jobs, classroomPublishWorker as worker, syncRuns } from "@/lib/db/schema";
import { WiseApiError } from "@/lib/wise/client";

export const PUBLISH_ATTEMPT_MS = 210_000;
const LEASE_MS = 300_000;
/**
 * Must equal RUNNING_SYNC_STALE_MS in @/lib/sync/manual-wise-sync.ts (itself
 * matching STALE_RUNNING_SYNC_MS in run-wise-sync.ts) -- a "running"
 * sync_runs row past this age is abandoned, not live, so it must not defer
 * every publish forever while automation is paused and nothing ever runs
 * failStaleRunningSyncs() to clean it up. Kept as its own constant (rather
 * than importing manual-wise-sync.ts) so this file -- reachable from every
 * consumer of classrooms/data.ts -- does not pull in that module's
 * "server-only" guard; a unit test cross-checks the two stay in sync.
 */
export const PUBLISH_QUEUE_RUNNING_SYNC_STALE_MS = 20 * 60 * 1000;
export interface PublishClaim { jobId: string; token: string; attemptCount: number; deadlineAt: number }
const attempt = new AsyncLocalStorage<PublishClaim>();
export const withPublishClaim = <T>(claim: PublishClaim, work: () => Promise<T>) => attempt.run(claim, work);

export class PublishDeferredError extends Error {
  constructor(message = "Publish attempt paused; live rooms will be checked again on retry") { super(message); }
}

/** A publish job started while a tutor Wise sync is running waits ~2 minutes and resumes automatically. */
export function publishSyncDeferral(syncRunning: boolean, now: Date): { nextAttemptAt: Date; lastError: string } | null {
  if (!syncRunning) return null;
  return { nextAttemptAt: new Date(now.getTime() + 2 * 60_000), lastError: "Waiting for the Wise sync to finish" };
}

export function publishRetryDelay(attemptCount: number, retryAfterMs: number | null = null): number {
  return Math.max(Math.min(30, 5 * 2 ** Math.min(3, Math.max(0, attemptCount - 1))) * 60_000, retryAfterMs ?? 0);
}

export function isRetryablePublishError(error: unknown): boolean {
  if (error instanceof PublishDeferredError) return true;
  if (error instanceof WiseApiError) return [408, 429, 500, 502, 503, 504].includes(error.status);
  return error instanceof Error && (error instanceof TypeError || ["AbortError", "TimeoutError"].includes(error.name)
    || /ROOMS_UPDATING|Rooms are being updated|fetch failed|ECONN|ETIMEDOUT|Incomplete Wise day pagination|duplicate or out-of-date Wise session/.test(error.message));
}

/** SQL fence on every attempt-owned persistence operation, including after an HTTP response. */
export function publishFence() {
  const claim = attempt.getStore();
  return claim ? sql`exists (select 1 from ${jobs} where ${jobs.id} = ${claim.jobId}
    and ${jobs.claimToken} = ${claim.token} and ${jobs.status} = 'running'
    and ${jobs.leaseExpiresAt} > now())` : sql`true`;
}

export async function assertPublishAttemptActive(db: Database) {
  const claim = attempt.getStore();
  if (!claim) return;
  if (Date.now() >= claim.deadlineAt) throw new PublishDeferredError();
  const [active] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, claim.jobId), publishFence())).limit(1);
  if (!active) throw new PublishDeferredError("Publish worker no longer owns this attempt");
}

/** The singleton serializes every publisher, while the existing day lease excludes room edits. */
export async function claimPublishAttempt(db: Database, jobId: string): Promise<PublishClaim | null> {
  return withDatabaseTransaction(db, async tx => {
    await tx.insert(worker).values({ id: "global" }).onConflictDoNothing();
    const [lock] = await tx.select().from(worker).where(eq(worker.id, "global")).for("update");
    const now = new Date();
    if (lock.leaseExpiresAt && lock.leaseExpiresAt > now) return null;
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!job || !["pending", "running"].includes(job.status)) return null;
    if (!wiseClassroomAutomationEnabled() && !isClassroomOperationsOwner(job.createdBy)) return null;
    if (job.status === "running" && job.leaseExpiresAt && job.leaseExpiresAt > now) return null;
    if (job.status === "pending" && job.nextAttemptAt > now) return null;
    // Same staleness cutoff as the manual sync guard: an abandoned "running"
    // row must not be able to defer every publish forever while automation
    // is paused and no sync ever runs to clean it up.
    const runningSyncCutoff = new Date(now.getTime() - PUBLISH_QUEUE_RUNNING_SYNC_STALE_MS);
    const [runningSync] = await tx.select({ id: syncRuns.id }).from(syncRuns)
      .where(and(eq(syncRuns.status, "running"), gt(syncRuns.startedAt, runningSyncCutoff))).limit(1);
    const syncDeferral = publishSyncDeferral(Boolean(runningSync), now);
    if (syncDeferral) {
      await tx.update(jobs).set({ status: "pending", nextAttemptAt: syncDeferral.nextAttemptAt, claimToken: null,
        leaseExpiresAt: null, updatedAt: now, lastError: syncDeferral.lastError }).where(eq(jobs.id, jobId));
      return null;
    }
    if (lock.cooldownUntil && lock.cooldownUntil > now) {
      await tx.update(jobs).set({ status: "pending", nextAttemptAt: lock.cooldownUntil, claimToken: null,
        leaseExpiresAt: null, updatedAt: now, lastError: "Waiting for Wise cooldown" }).where(eq(jobs.id, jobId));
      return null;
    }
    const token = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    await tx.update(worker).set({ jobId, claimToken: token, leaseExpiresAt, cooldownUntil: null }).where(eq(worker.id, "global"));
    await tx.update(jobs).set({ status: "running", claimToken: token, leaseExpiresAt, attemptCount: job.attemptCount + 1,
      startedAt: job.startedAt ?? now, finishedAt: null, verifiedAt: null, lastError: null, updatedAt: now,
      completedCount: 0, successCount: 0, failedCount: 0, skippedCount: 0 }).where(eq(jobs.id, jobId));
    return { jobId, token, attemptCount: job.attemptCount + 1, deadlineAt: now.getTime() + PUBLISH_ATTEMPT_MS };
  });
}

export async function releasePublishAttempt(db: Database, claim: PublishClaim, error?: unknown) {
  const now = new Date();
  const retry = error !== undefined && isRetryablePublishError(error);
  const nextAttemptAt = new Date(now.getTime() + publishRetryDelay(claim.attemptCount,
    error instanceof WiseApiError ? error.retryAfterMs : null));
  await withDatabaseTransaction(db, async tx => {
    // Match claim tokens even if the attempt expired; never change a replacement worker's state.
    if (error !== undefined) {
      await tx.update(jobs).set({ status: retry ? "pending" : "failed", nextAttemptAt,
        lastError: error instanceof Error ? error.message : "Publish attempt failed",
        finishedAt: retry ? null : now, updatedAt: now, claimToken: null, leaseExpiresAt: null,
      }).where(and(eq(jobs.id, claim.jobId), eq(jobs.claimToken, claim.token)));
    } else {
      await tx.update(jobs).set({ claimToken: null, leaseExpiresAt: null }).where(and(eq(jobs.id, claim.jobId), eq(jobs.claimToken, claim.token)));
    }
    await tx.update(worker).set({ jobId: null, claimToken: null, leaseExpiresAt: null,
      ...(error instanceof WiseApiError && error.status === 429 ? { cooldownUntil: nextAttemptAt } : {}),
    }).where(and(eq(worker.id, "global"), eq(worker.claimToken, claim.token)));
  });
}
