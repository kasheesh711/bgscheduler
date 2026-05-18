import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createWiseClient } from "@/lib/wise/client";
import { runFullSync } from "@/lib/sync/orchestrator";

export const STALE_RUNNING_SYNC_MS = 20 * 60 * 1000;

interface RunningSyncRun {
  id: string;
  startedAt: Date;
}

interface SyncGuardResult {
  syncRunId: string;
  staleRunningSyncsFailed: number;
}

interface SkippedSyncResult {
  success: true;
  skipped: true;
  alreadyRunning: true;
  syncRunId: string;
  snapshotId: null;
  promotedSnapshotId: null;
  teacherCount: 0;
  groupCount: 0;
  issueCount: 0;
  errorSummary: null;
  durationMs: 0;
  message: string;
  runningStartedAt: string;
  staleRunningSyncsFailed: number;
}

const STALE_RUNNING_SYNC_ERROR =
  "Sync marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

async function failStaleRunningSyncs(
  db: Database,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_SYNC_MS);
  const rows = await db
    .update(schema.syncRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: STALE_RUNNING_SYNC_ERROR,
    })
    .where(
      and(
        eq(schema.syncRuns.status, "running"),
        lt(schema.syncRuns.startedAt, cutoff),
      ),
    )
    .returning({ id: schema.syncRuns.id });

  return rows.length;
}

async function findRunningSyncRun(db: Database): Promise<RunningSyncRun | null> {
  const [running] = await db
    .select({
      id: schema.syncRuns.id,
      startedAt: schema.syncRuns.startedAt,
    })
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "running"))
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1);

  return running ?? null;
}

async function acquireSyncRun(
  db: Database,
  now: Date,
): Promise<SyncGuardResult | SkippedSyncResult> {
  const staleRunningSyncsFailed = await failStaleRunningSyncs(db, now);
  const currentRunning = await findRunningSyncRun(db);

  if (currentRunning) {
    return skippedSyncResult(currentRunning, staleRunningSyncsFailed);
  }

  try {
    const [syncRun] = await db
      .insert(schema.syncRuns)
      .values({ status: "running", startedAt: now })
      .returning({ id: schema.syncRuns.id });

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

function skippedSyncResult(
  running: RunningSyncRun,
  staleRunningSyncsFailed: number,
): SkippedSyncResult {
  return {
    success: true,
    skipped: true,
    alreadyRunning: true,
    syncRunId: running.id,
    snapshotId: null,
    promotedSnapshotId: null,
    teacherCount: 0,
    groupCount: 0,
    issueCount: 0,
    errorSummary: null,
    durationMs: 0,
    message: "Wise sync is already running. Data will refresh when that run finishes.",
    runningStartedAt: running.startedAt.toISOString(),
    staleRunningSyncsFailed,
  };
}

export async function runWiseSyncRequest() {
  const db = getDb();
  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const guard = await acquireSyncRun(db, new Date());

  if ("skipped" in guard) {
    return NextResponse.json(guard, { status: 202 });
  }

  const result = await runFullSync(db, client, instituteId, {
    syncRunId: guard.syncRunId,
  });
  const body = {
    ...result,
    staleRunningSyncsFailed: guard.staleRunningSyncsFailed,
  };

  if (result.success) {
    revalidateTag("snapshot", { expire: 0 });
  }

  return NextResponse.json(body, {
    status: result.success ? 200 : 500,
  });
}
