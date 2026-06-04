import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runCreditControlSyncRequest } from "@/lib/credit-control/run-sync-request";

export const maxDuration = 300;

type CronSecretStatus = "valid" | "invalid" | "missing-secret";

function hasValidCronSecret(request: NextRequest): CronSecretStatus {
  const authHeader = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return "missing-secret";
  }

  const received = Buffer.from(authHeader);
  const known = Buffer.from(`Bearer ${cronSecret}`);
  const valid = received.length === known.length && timingSafeEqual(received, known);

  return valid ? "valid" : "invalid";
}

async function handleSync(request: NextRequest, options: { allowSessionAuth: boolean }) {
  const cronSecretStatus = hasValidCronSecret(request);

  if (cronSecretStatus === "valid") {
    return withCronInvocationAudit(
      { jobKey: "credit_control", triggerSource: "cron", requestMethod: request.method },
      () => runCreditControlSyncRequest(),
    );
  }

  if (options.allowSessionAuth) {
    const session = await auth();
    if (session) {
      return withCronInvocationAudit(
        {
          jobKey: "credit_control",
          triggerSource: "admin",
          actorEmail: session.user?.email ?? null,
          requestMethod: request.method,
        },
        () => runCreditControlSyncRequest(),
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
