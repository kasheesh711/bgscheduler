import { NextRequest, NextResponse } from "next/server";

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { runPostClassReminderJob } from "@/lib/post-class-feedback/reminder-job";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit(
    { jobKey: "post_class_feedback_day_after", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await runPostClassReminderJob("day_after", { triggerType: "cron" });
        if (!result.ready) {
          return NextResponse.json({
            ok: false,
            error: "Post-class day-after reminder checkpoint still has unreconciled Wise sessions.",
            result,
          }, { status: 503 });
        }
        return NextResponse.json({ ok: true, result });
      } catch {
        return NextResponse.json({ error: "Post-class day-after reminder job failed" }, { status: 500 });
      }
    },
  );
}
