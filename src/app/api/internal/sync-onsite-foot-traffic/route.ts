import { NextRequest, NextResponse } from "next/server";

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { getDb } from "@/lib/db";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { runOnsiteFootTrafficSync } from "@/lib/onsite-foot-traffic/sync";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit(
    { jobKey: "onsite_foot_traffic", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await runOnsiteFootTrafficSync(getDb(), { triggerType: "cron" });
        return NextResponse.json(result, { status: result.skipped ? 202 : 200 });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Onsite foot-traffic sync failed";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  );
}
