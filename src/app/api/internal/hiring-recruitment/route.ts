import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { deliverRecruitment, queueRecruitmentWeekly } from "@/lib/hiring/recruitment";
import { hiringError } from "@/lib/hiring/http";

export const maxDuration = 120;
export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;
  return withCronInvocationAudit({ jobKey: "hiring_recruitment", triggerSource: "cron", requestMethod: request.method }, async () => {
    try {
      const db = getDb();
      const queued = await queueRecruitmentWeekly(db);
      return NextResponse.json({ queued, sent: await deliverRecruitment(db) });
    } catch (error) { return hiringError(error); }
  });
}
