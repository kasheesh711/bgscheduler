import { type NextRequest, NextResponse } from "next/server";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runAutowriterReviewJob } from "@/lib/feedback-autowriter/dispatch";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";

export const maxDuration = 300;

/**
 * Hourly review job of the autowriter operating loop: first-shot snapshots, measured fixes, review inclusion,
 * quality metrics, the daily gate and critical-incident pushes. Reads our database only; never writes to Wise.
 */
export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit({ jobKey: "feedback_autowriter_review", triggerSource: "cron", requestMethod: "GET" }, async () => {
    try {
      const result = await runAutowriterReviewJob("cron");
      return NextResponse.json(result, { status: result.ok ? 200 : 503 });
    } catch (error) {
      console.error("[feedback-autowriter] review job failed", error instanceof Error ? error.name : "Error");
      return NextResponse.json({ ok: false, error: "Feedback autowriter review job could not complete." }, { status: 503 });
    }
  });
}
