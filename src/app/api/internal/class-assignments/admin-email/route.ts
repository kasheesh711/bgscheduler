import { NextRequest, NextResponse } from "next/server";
import { deliverNextDayClassroomSchedules } from "@/lib/classrooms/daily-automation";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;

  return withCronInvocationAudit(
    { jobKey: "classroom_admin_email", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await deliverNextDayClassroomSchedules();
        const status = result.ok ? 200 : 500;
        return NextResponse.json(result, { status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Admin classroom schedule email failed";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  );
}
