import { NextResponse } from "next/server";
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createWiseClient } from "@/lib/wise/client";
import { STALE_RUNNING_PROGRESS_TEST_SYNC_MS } from "./config";
import { runProgressTestSync } from "./sync";

const STALE_RUNNING_PROGRESS_TEST_SYNC_ERROR =
  "Progress test sync marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.";

interface RunningProgressTestSyncRun {
  id: string;
  startedAt: Date;
}

interface ProgressTestSyncGuardResult {
  syncRunId: string;
  staleRunningSyncsFailed: number;
}

interface SkippedProgressTestSyncResult {
  success: true;
  skipped: true;
  alreadyRunning: true;
  syncRunId: string;
  ledgerRowCount: 0;
  enrollmentCount: 0;
  approachingCount: 0;
  dueCount: 0;
  unresolvedTeacherCount: 0;
  errorSummary: null;
  message: string;
  runningStartedAt: string;
  staleRunningSyncsFailed: number;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

async function failStaleRunningSyncs(db: Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_PROGRESS_TEST_SYNC_MS);
  const rows = await db
    .update(schema.progressTestSyncRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: STALE_RUNNING_PROGRESS_TEST_SYNC_ERROR,
    })
    .where(
      and(
        eq(schema.progressTestSyncRuns.status, "running"),
        lt(schema.progressTestSyncRuns.startedAt, cutoff),
      ),
    )
    .returning({ id: schema.progressTestSyncRuns.id });

  return rows.length;
}

async function findRunningSyncRun(db: Database): Promise<RunningProgressTestSyncRun | null> {
  const [running] = await db
    .select({
      id: schema.progressTestSyncRuns.id,
      startedAt: schema.progressTestSyncRuns.startedAt,
    })
    .from(schema.progressTestSyncRuns)
    .where(eq(schema.progressTestSyncRuns.status, "running"))
    .orderBy(desc(schema.progressTestSyncRuns.startedAt))
    .limit(1);

  return running ?? null;
}

function skippedSyncResult(
  running: RunningProgressTestSyncRun,
  staleRunningSyncsFailed: number,
): SkippedProgressTestSyncResult {
  return {
    success: true,
    skipped: true,
    alreadyRunning: true,
    syncRunId: running.id,
    ledgerRowCount: 0,
    enrollmentCount: 0,
    approachingCount: 0,
    dueCount: 0,
    unresolvedTeacherCount: 0,
    errorSummary: null,
    message: "Progress test sync is already running. Data will refresh when that run finishes.",
    runningStartedAt: running.startedAt.toISOString(),
    staleRunningSyncsFailed,
  };
}

async function acquireSyncRun(
  db: Database,
  now: Date,
  triggerType: string,
  actorEmail: string | null,
): Promise<ProgressTestSyncGuardResult | SkippedProgressTestSyncResult> {
  const staleRunningSyncsFailed = await failStaleRunningSyncs(db, now);
  const currentRunning = await findRunningSyncRun(db);

  if (currentRunning) {
    return skippedSyncResult(currentRunning, staleRunningSyncsFailed);
  }

  try {
    const [syncRun] = await db
      .insert(schema.progressTestSyncRuns)
      .values({ status: "running", startedAt: now, triggerType, actorEmail })
      .returning({ id: schema.progressTestSyncRuns.id });

    return { syncRunId: syncRun.id, staleRunningSyncsFailed };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }

    const running = await findRunningSyncRun(db);
    if (!running) {
      throw err;
    }

    return skippedSyncResult(running, staleRunningSyncsFailed);
  }
}

export async function runProgressTestSyncRequest(
  options: { triggerType?: string; actorEmail?: string | null } = {},
) {
  const db = getDb();
  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const now = new Date();
  const guard = await acquireSyncRun(db, now, options.triggerType ?? "manual", options.actorEmail ?? null);

  if ("skipped" in guard) {
    return NextResponse.json(guard, { status: 202 });
  }

  const result = await runProgressTestSync({
    db,
    client,
    instituteId,
    now,
    syncRunId: guard.syncRunId,
  });

  return NextResponse.json({
    ...result,
    syncRunId: guard.syncRunId,
    staleRunningSyncsFailed: guard.staleRunningSyncsFailed,
  }, {
    status: result.success ? 200 : 500,
  });
}
