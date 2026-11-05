import { theaEnabled } from "@/lib/classrooms/thea-config";
import { runTheaWeekendWorker } from "@/lib/classrooms/thea-weekend";
import { pausedWiseClassroomResult, wiseClassroomAutomationEnabled } from "@/lib/classrooms/operations-policy";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runClassroomPublishRecovery } from "@/lib/classrooms/publish-worker";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;
  return withCronInvocationAudit({ jobKey: "classroom_publish_recovery", triggerSource: "cron", requestMethod: request.method }, async () => {
      const thea = theaEnabled() ? await runTheaWeekendWorker(getDb()) : { handled: false };
      if (thea.handled) return NextResponse.json(thea);
      if (process.env.THEA_TEACHER_QUERIES_ENABLED === "true") {
        const { runTheaQueryWorker } = await import("@/lib/line/thea-query-queue");
        const queries = await runTheaQueryWorker(getDb());
        if (queries.handled) return NextResponse.json(queries);
      }
      if (!wiseClassroomAutomationEnabled()) return NextResponse.json(pausedWiseClassroomResult());
    try {
      const result = await runClassroomPublishRecovery(getDb());
      return NextResponse.json(result, { status: result.ok ? 200 : 500 });
    } catch (error) {
      return NextResponse.json({ ok: false, errorSummary: error instanceof Error ? error.message : "Classroom publish recovery failed" }, { status: 500 });
    }
  });
}
