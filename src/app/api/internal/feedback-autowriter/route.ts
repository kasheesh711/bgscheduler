import { type NextRequest, NextResponse } from "next/server";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runAutowriterJob } from "@/lib/feedback-autowriter/dispatch";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";

export const maxDuration = 800;

/** Backstop sweep for the feedback autowriter (the Wise webhook is the fast path). */
export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit({ jobKey: "feedback_autowriter", triggerSource: "cron", requestMethod: "GET" }, async () => {
    try {
      const result = await runAutowriterJob();
      return NextResponse.json(result, { status: result.ok ? 200 : 503 });
    } catch (error) {
      console.error("[feedback-autowriter] sweep failed", error instanceof Error ? error.name : "Error");
      return NextResponse.json({ ok: false, error: "Feedback autowriter sweep could not complete." }, { status: 503 });
    }
  });
}
