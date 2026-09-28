import { NextRequest, NextResponse } from "next/server";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { nightlyWorkerOutcome, runNightlyReminders } from "@/lib/post-class-feedback/nightly-reminders";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit({ jobKey: "post_class_feedback_nightly", triggerSource: "cron", requestMethod: "GET" }, async () => {
    try {
      const result = nightlyWorkerOutcome(await runNightlyReminders());
      return NextResponse.json(result, { status: result.ok ? 200 : 503 });
    } catch {
      return NextResponse.json({ ok: false, error: "Nightly feedback reminders could not complete." }, { status: 503 });
    }
  });
}
