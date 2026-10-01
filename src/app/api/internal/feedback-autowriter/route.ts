import { type NextRequest, NextResponse } from "next/server";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runAutowriterJob } from "@/lib/feedback-autowriter/dispatch";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { cleanupClassCaptures } from "@/lib/class-capture/cleanup";

export const maxDuration = 800;

/** Backstop sweep for the feedback autowriter (the Wise webhook is the fast path). */
export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit({ jobKey: "feedback_autowriter", triggerSource: "cron", requestMethod: "GET" }, async () => {
    try {
      // Retention remains independent of the autowriter and capture activation switches.
      // Run the bounded retention work alongside the existing 740s job so its
      // deadline and tutor/payroll behavior are not shortened by this addition.
      const [result, captureRetention] = await Promise.all([
        runAutowriterJob(),
        cleanupClassCaptures().catch(() => ({ enabled: true, ok: false, failed: 1 })),
      ]);
      return NextResponse.json({ ...result, captureRetention }, { status: result.ok && captureRetention.ok ? 200 : 503 });
    } catch (error) {
      console.error("[feedback-autowriter] sweep failed", error instanceof Error ? error.name : "Error");
      return NextResponse.json({ ok: false, error: "Feedback autowriter sweep could not complete." }, { status: 503 });
    }
  });
}
