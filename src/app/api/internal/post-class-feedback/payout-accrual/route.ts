import { NextRequest, NextResponse } from "next/server";

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import {
  runPayoutAccrualPass,
  runPayoutFinalizePass,
} from "@/lib/post-class-feedback/payout-accrual";

export const maxDuration = 800;

// Parked: no vercel.json entry. Reachable only manually from Data Health
// (manualOnly + dangerous in cron-registry.ts) until a later, separate flip
// adds a schedule. Runs the accrual pass unconditionally, then the finalize
// pass -- which itself no-ops with { skipped: "window-not-ended" } until the
// 26th-to-25th payout window has ended, so a single invocation is always
// "accrue, then finalize if the window has ended".
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
        return NextResponse.json({ ok: true, accrual, finalize });
      } catch {
        return NextResponse.json(
          { error: "Post-class payout accrual failed" },
          { status: 500 },
        );
      }
    },
  );
}
