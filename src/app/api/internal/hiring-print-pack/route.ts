import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { hiringError } from "@/lib/hiring/http";
import { queuePrintPack } from "@/lib/hiring/print-pack";
import { deliverRecruitment } from "@/lib/hiring/recruitment";

export const maxDuration = 120;
/** 08:29 Bangkok: tags the print person in the recruitment group with one link to print the day's paper tests. */
export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;
  return withCronInvocationAudit({ jobKey: "hiring_print_pack", triggerSource: "cron", requestMethod: request.method }, async () => {
    try {
      const db = getDb();
      const queued = await queuePrintPack(db);
      return NextResponse.json({ queued, sent: await deliverRecruitment(db) });
    } catch (error) { return hiringError(error); }
  });
}
