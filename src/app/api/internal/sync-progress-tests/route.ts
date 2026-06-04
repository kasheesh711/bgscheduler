import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCronSecretStatus } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runProgressTestSyncRequest } from "@/lib/progress-tests/run-sync-request";

export const maxDuration = 300;

async function handleSync(request: NextRequest, options: { allowSessionAuth: boolean }) {
  const cronSecretStatus = getCronSecretStatus(request);

  if (cronSecretStatus === "valid") {
    return withCronInvocationAudit(
      { jobKey: "progress_tests", triggerSource: "cron", requestMethod: request.method },
      () => runProgressTestSyncRequest({ triggerType: "cron" }),
    );
  }

  if (options.allowSessionAuth) {
    const session = await auth();
    if (session) {
      return withCronInvocationAudit(
        {
          jobKey: "progress_tests",
          triggerSource: "admin",
          actorEmail: session.user?.email ?? null,
          requestMethod: request.method,
        },
        () => runProgressTestSyncRequest({ triggerType: "admin", actorEmail: session.user?.email ?? null }),
      );
    }
  }

  if (cronSecretStatus === "missing-secret") {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: NextRequest) {
  return handleSync(request, { allowSessionAuth: false });
}

export async function POST(request: NextRequest) {
  return handleSync(request, { allowSessionAuth: true });
}
