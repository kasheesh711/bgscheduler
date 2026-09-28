import { NextRequest, NextResponse } from "next/server";

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import {
  payoutJobResponse,
  runPayoutAccrualPass,
  runPayoutFinalizePass,
} from "@/lib/post-class-feedback/payout-accrual";

export const maxDuration = 800;

// Armed: hourly vercel.json cron (33 * * * *), and also runnable manually
// from Data Health (dangerous + confirm-gated in cron-registry.ts). Runs the
// accrual pass unconditionally, then the finalize pass -- which itself no-ops
// with { skipped: "window-not-ended" } until the 26th-to-25th payout window
// has ended, so a single invocation is always "accrue, then finalize if the
// window has ended".
export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;

  return withCronInvocationAudit(
    {
      jobKey: "post_class_feedback_payout_accrual",
      triggerSource: "cron",
      requestMethod: request.method,
    },
    async () => {
      try {
        const accrual = await runPayoutAccrualPass();
        const finalize = await runPayoutFinalizePass();
        const result = payoutJobResponse(accrual, finalize);
        return NextResponse.json(result, { status: result.ok ? 200 : 503 });
      } catch (error) {
        return NextResponse.json(
          { ok: false, error: error instanceof Error ? error.message : "Post-class payout accrual failed" },
          { status: 500 },
        );
      }
    },
  );
}
