import { NextRequest, NextResponse } from "next/server";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { getDb } from "@/lib/db";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { createWiseClient } from "@/lib/wise/client";
import { syncWiseActivityEvents, WiseActivitySyncAlreadyRunningError } from "@/lib/wise-activity/sync";

export const maxDuration = 800;

const DEFAULT_INSTITUTE_ID = "696e1f4d90102225641cc413";

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;

  return withCronInvocationAudit(
    { jobKey: "wise_activity", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await syncWiseActivityEvents(
          getDb(),
          createWiseClient(),
          process.env.WISE_INSTITUTE_ID ?? DEFAULT_INSTITUTE_ID,
          { triggerType: "cron" },
        );
        return NextResponse.json({ ok: true, result });
      } catch (error) {
        if (error instanceof WiseActivitySyncAlreadyRunningError) {
          return NextResponse.json({ error: error.message }, { status: 409 });
        }
        const message = error instanceof Error ? error.message : "Wise activity sync failed";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  );
}
