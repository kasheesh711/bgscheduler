import { NextRequest, NextResponse } from "next/server";

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { runUnearnedRevenueSync } from "@/lib/unearned-revenue/sync";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;
  return withCronInvocationAudit(
    { jobKey: "unearned_revenue", triggerSource: "cron", requestMethod: request.method },
    async () => {
      const result = await runUnearnedRevenueSync({ triggerType: "cron" });
      return NextResponse.json(result, { status: result.ok ? result.skipped ? 202 : 200 : 502 });
    },
  );
}
