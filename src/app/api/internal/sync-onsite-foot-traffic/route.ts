import { NextRequest, NextResponse } from "next/server";

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { getDb } from "@/lib/db";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { runOnsiteFootTrafficSync } from "@/lib/onsite-foot-traffic/sync";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  const modeParam = request.nextUrl.searchParams.get("mode");
  const isManualBackfill = modeParam === "backfill";
  if (modeParam && !isManualBackfill) {
    return NextResponse.json({ error: "mode must be backfill when supplied" }, { status: 400 });
  }
  const startDate = request.nextUrl.searchParams.get("startDate") ?? undefined;
  const endDate = request.nextUrl.searchParams.get("endDate") ?? undefined;
  if (!isManualBackfill && (startDate || endDate)) {
    return NextResponse.json({ error: "date bounds require mode=backfill" }, { status: 400 });
  }
  return withCronInvocationAudit(
    {
      jobKey: "onsite_foot_traffic",
      triggerSource: isManualBackfill ? "system" : "cron",
      requestMethod: request.method,
    },
    async () => {
      try {
        const result = await runOnsiteFootTrafficSync(getDb(), isManualBackfill
          ? { mode: "backfill", startDate, endDate, triggerType: "manual" }
          : { triggerType: "cron" });
        return NextResponse.json(result, { status: result.skipped ? 202 : 200 });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Onsite foot-traffic sync failed";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  );
}
