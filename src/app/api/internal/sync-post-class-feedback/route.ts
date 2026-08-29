import { NextRequest, NextResponse } from "next/server";

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { processPostClassAiReviews } from "@/lib/post-class-feedback/ai";
import { runPostClassDeductionHygiene } from "@/lib/post-class-feedback/auto-approval";
import { processDuePostClassNotificationRetries } from "@/lib/post-class-feedback/notifications";
import {
  PostClassFeedbackSyncAlreadyRunningError,
} from "@/lib/post-class-feedback/repository";
import { runPostClassFeedbackSync } from "@/lib/post-class-feedback/sync";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit(
    { jobKey: "post_class_feedback", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await runPostClassFeedbackSync({ triggerType: "cron" });
        const [ai, retries, hygiene] = await Promise.allSettled([
          processPostClassAiReviews(),
          processDuePostClassNotificationRetries(),
          // Reopen unproven approvals and waive deductions on sessions the
          // sync just found ineligible (e.g. cancelled in Wise) — releases
          // claims only, never approves.
          runPostClassDeductionHygiene(),
        ]);
        return NextResponse.json({
          ok: true,
          result,
          ai: ai.status === "fulfilled" ? ai.value : { failed: true },
          retries: retries.status === "fulfilled" ? retries.value : { failed: true },
          hygiene: hygiene.status === "fulfilled" ? hygiene.value : { failed: true },
        });
      } catch (error) {
        if (error instanceof PostClassFeedbackSyncAlreadyRunningError) {
          return NextResponse.json({ error: error.message }, { status: 409 });
        }
        return NextResponse.json({ error: "Post-class feedback sync failed" }, { status: 500 });
      }
    },
  );
}
