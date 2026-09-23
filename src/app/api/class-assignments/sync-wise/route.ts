import { NextResponse } from "next/server";
import { requireClassroomAdmin, classroomOperationsAccessError } from "@/lib/classrooms/operations-access";
import { getDb } from "@/lib/db";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import {
  decideManualWiseSync,
  getLatestSuccessfulSyncFinishedAt,
  getRunningSyncStartedAt,
  getTypicalSyncDurationMs,
} from "@/lib/sync/manual-wise-sync";

export const maxDuration = 800; // Pro-plan headroom for full Wise syncs

/** Any current admin (not just Kevin) may trigger this, rate-limit-guarded so Wise is never double-hit. */
export async function POST() {
  let actor;
  try { actor = await requireClassroomAdmin(); }
  catch (error) { return classroomOperationsAccessError(error); }

  const db = getDb();
  // Sequential (not Promise.all): keeps read order deterministic for tests
  // and avoids issuing three concurrent reads for a single decision.
  const latestSuccessFinishedAt = await getLatestSuccessfulSyncFinishedAt(db);
  const runningStartedAt = await getRunningSyncStartedAt(db);
  const typicalDurationMs = await getTypicalSyncDurationMs(db);

  const decision = decideManualWiseSync({ latestSuccessFinishedAt, runningStartedAt, now: new Date() });

  if (decision.action === "skip_fresh") {
    return NextResponse.json({
      outcome: "success",
      success: true,
      skipped: true,
      reason: "fresh",
      finishedAt: decision.finishedAt,
      promotedSnapshotId: null,
      typicalDurationMs,
    });
  }

  // "wait" and "start" both delegate to the existing single-flight guard,
  // which atomically re-detects an already-running sync itself.
  const response = await withCronInvocationAudit(
    {
      jobKey: "wise_snapshot",
      triggerSource: "admin",
      actorEmail: actor.email,
      requestMethod: "POST",
    },
    () => runWiseSyncRequest({ manualOwner: actor.email }),
  );
  const body = await response.json();
  return NextResponse.json({ ...body, typicalDurationMs }, { status: response.status });
}
