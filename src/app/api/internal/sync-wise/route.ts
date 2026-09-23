import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { requireClassroomOperationsOwner, classroomOperationsAccessError } from "@/lib/classrooms/operations-access";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import { getDb } from "@/lib/db";
import { getLatestSuccessfulSyncFinishedAt } from "@/lib/sync/manual-wise-sync";
import { wiseClassroomAutomationEnabled } from "@/lib/classrooms/operations-policy";

export const maxDuration = 800; // Pro-plan headroom for full Wise syncs

/** Skip a scheduled cron sync when a manual or cron run already succeeded this recently. */
const CRON_SYNC_DEDUPE_MS = 10 * 60_000;

async function runCronWiseSync(): Promise<Response> {
  // Read the same pause flag runWiseSyncRequest() checks internally, purely to
  // skip the DB-touching freshness pre-check while paused -- the actual pause
  // decision still lives solely inside runWiseSyncRequest(), not here.
  if (!wiseClassroomAutomationEnabled()) {
    return runWiseSyncRequest();
  }
  const latestSuccessFinishedAt = await getLatestSuccessfulSyncFinishedAt(getDb());
  if (latestSuccessFinishedAt && Date.now() - latestSuccessFinishedAt.getTime() < CRON_SYNC_DEDUPE_MS) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "RECENTLY_SYNCED",
      message: "Wise was already synced within the last 10 minutes; skipping this scheduled run.",
      finishedAt: latestSuccessFinishedAt.toISOString(),
    });
  }
  return runWiseSyncRequest();
}

type CronSecretStatus = "valid" | "invalid" | "missing-secret";

function hasValidCronSecret(request: NextRequest): CronSecretStatus {
  // REL-07: constant-time CRON_SECRET comparison. The length-pre-check
  // avoids the RangeError that crypto.timingSafeEqual throws on
  // length-mismatched Buffers, and is itself O(1) — it does not leak
  // the secret length via timing.
  const authHeader = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return "missing-secret";
  }

  const received = Buffer.from(authHeader);
  const known = Buffer.from(`Bearer ${cronSecret}`);
  const valid =
    received.length === known.length && timingSafeEqual(received, known);

  return valid ? "valid" : "invalid";
}

/** Shared sync handler for both GET (Vercel cron) and POST (manual admin/curl) */
async function handleSync(
  request: NextRequest,
  options: { allowSessionAuth: boolean },
) {
  const cronSecretStatus = hasValidCronSecret(request);

  if (cronSecretStatus === "valid") {
    return withCronInvocationAudit(
      { jobKey: "wise_snapshot", triggerSource: "cron", requestMethod: request.method },
      () => runCronWiseSync(),
    );
  }

  if (options.allowSessionAuth) {
    try {
      const actor = await requireClassroomOperationsOwner();
      return withCronInvocationAudit(
        { jobKey: "wise_snapshot", triggerSource: "admin", actorEmail: actor.email, requestMethod: request.method },
        () => runWiseSyncRequest({ manualOwner: actor.email }),
      );
    } catch (error) {
      if (!(error instanceof AdminUsersAccessError) || error.status !== 401) {
        return classroomOperationsAccessError(error);
      }
    }
  }

  if (cronSecretStatus === "missing-secret") {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** Vercel cron triggers via GET */
export async function GET(request: NextRequest) {
  return handleSync(request, { allowSessionAuth: false });
}

/** Manual trigger via Auth.js session or curl -X POST (backward compatible) */
export async function POST(request: NextRequest) {
  return handleSync(request, { allowSessionAuth: true });
}
