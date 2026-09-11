import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runClassroomPublishRecovery } from "@/lib/classrooms/publish-worker";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;
  return withCronInvocationAudit({ jobKey: "classroom_publish_recovery", triggerSource: "cron", requestMethod: request.method }, async () => {
    try {
      const result = await runClassroomPublishRecovery(getDb());
      return NextResponse.json(result, { status: result.ok ? 200 : 500 });
    } catch (error) {
      return NextResponse.json({ ok: false, errorSummary: error instanceof Error ? error.message : "Classroom publish recovery failed" }, { status: 500 });
    }
  });
}
