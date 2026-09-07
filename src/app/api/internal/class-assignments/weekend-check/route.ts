import { NextRequest, NextResponse } from "next/server";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runWeekendClassroomCheck } from "@/lib/classrooms/weekend-check";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;
  return withCronInvocationAudit({ jobKey: "classroom_weekend_check", triggerSource: "cron", requestMethod: request.method }, async () => {
    try {
      const result = await runWeekendClassroomCheck();
      return NextResponse.json(result, { status: result.ok ? 200 : 500 });
    } catch (error) {
      return NextResponse.json({ ok: false, errorSummary: error instanceof Error ? error.message : "Weekend check failed" }, { status: 500 });
    }
  });
}
