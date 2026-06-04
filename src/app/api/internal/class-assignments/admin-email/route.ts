import { NextRequest, NextResponse } from "next/server";
import { sendAdminClassroomScheduleEmail } from "@/lib/classrooms/admin-schedule-email";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;

  return withCronInvocationAudit(
    { jobKey: "classroom_admin_email", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await sendAdminClassroomScheduleEmail();
        const status = result.status === "failed" ? 500 : 200;
        return NextResponse.json(result, { status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Admin classroom schedule email failed";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  );
}
