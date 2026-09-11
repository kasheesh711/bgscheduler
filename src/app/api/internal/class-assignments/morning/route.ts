import { NextRequest, NextResponse } from "next/server";
import { prepareNextDayClassrooms } from "@/lib/classrooms/daily-automation";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;

  return withCronInvocationAudit(
    { jobKey: "classroom_morning", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await prepareNextDayClassrooms();
        return NextResponse.json(result, { status: result.ok ? 200 : 500 });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Next-day classroom preparation failed";
        return NextResponse.json({ ok: false, error: message }, { status: 500 });
      }
    },
  );
}
