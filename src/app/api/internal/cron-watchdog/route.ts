import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { runCronWatchdog } from "@/lib/internal/cron-watchdog";

export const maxDuration = 300;

async function handle(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;

  return withCronInvocationAudit(
    { jobKey: "cron_watchdog", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await runCronWatchdog(getDb());
        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        console.error("Cron watchdog sweep failed", error);
        const message = error instanceof Error ? error.message : "Cron watchdog sweep failed";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  );
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
