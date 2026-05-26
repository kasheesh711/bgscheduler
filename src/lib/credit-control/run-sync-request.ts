import { NextResponse } from "next/server";
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createWiseClient } from "@/lib/wise/client";
import { runCreditControlSync } from "@/lib/credit-control/sync";

export const STALE_RUNNING_CREDIT_CONTROL_SYNC_MS = 20 * 60 * 1000;

const STALE_RUNNING_CREDIT_CONTROL_SYNC_ERROR =
  "Credit control sync marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.";

interface RunningCreditControlSyncRun {
  id: string;
  startedAt: Date;
}

interface CreditControlSyncGuardResult {
  syncRunId: string;
  staleRunningSyncsFailed: number;
}

interface SkippedCreditControlSyncResult {
  success: true;
  skipped: true;
  alreadyRunning: true;
  syncRunId: string;
  snapshotId: null;
  promotedSnapshotId: null;
  studentCount: 0;
  packageCount: 0;
  sessionCount: 0;
  failedCreditPairs: 0;
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
  const cutoff = new Date(now.getTime() - STALE_RUNNING_CREDIT_CONTROL_SYNC_MS);
  const rows = await db
    .update(schema.creditControlSyncRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: STALE_RUNNING_CREDIT_CONTROL_SYNC_ERROR,
    })
    .where(
      and(
        eq(schema.creditControlSyncRuns.status, "running"),
        lt(schema.creditControlSyncRuns.startedAt, cutoff),
      ),
    )
    .returning({ id: schema.creditControlSyncRuns.id });

  return rows.length;
}

async function findRunningSyncRun(db: Database): Promise<RunningCreditControlSyncRun | null> {
  const [running] = await db
    .select({
      id: schema.creditControlSyncRuns.id,
      startedAt: schema.creditControlSyncRuns.startedAt,
    })
    .from(schema.creditControlSyncRuns)
    .where(eq(schema.creditControlSyncRuns.status, "running"))
    .orderBy(desc(schema.creditControlSyncRuns.startedAt))
    .limit(1);

  return running ?? null;
}

function skippedSyncResult(
  running: RunningCreditControlSyncRun,
  staleRunningSyncsFailed: number,
): SkippedCreditControlSyncResult {
  return {
    success: true,
    skipped: true,
    alreadyRunning: true,
    syncRunId: running.id,
    snapshotId: null,
    promotedSnapshotId: null,
    studentCount: 0,
    packageCount: 0,
    sessionCount: 0,
    failedCreditPairs: 0,
    errorSummary: null,
    message: "Credit control sync is already running. Data will refresh when that run finishes.",
    runningStartedAt: running.startedAt.toISOString(),
    staleRunningSyncsFailed,
  };
}

async function acquireSyncRun(
  db: Database,
  now: Date,
): Promise<CreditControlSyncGuardResult | SkippedCreditControlSyncResult> {
  const staleRunningSyncsFailed = await failStaleRunningSyncs(db, now);
  const currentRunning = await findRunningSyncRun(db);

  if (currentRunning) {
    return skippedSyncResult(currentRunning, staleRunningSyncsFailed);
  }

  try {
    const [syncRun] = await db
      .insert(schema.creditControlSyncRuns)
      .values({ status: "running", startedAt: now })
      .returning({ id: schema.creditControlSyncRuns.id });

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

export async function runCreditControlSyncRequest() {
  const db = getDb();
  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const now = new Date();
  const guard = await acquireSyncRun(db, now);

  if ("skipped" in guard) {
    return NextResponse.json(guard, { status: 202 });
  }

  const result = await runCreditControlSync(db, client, instituteId, now, {
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
