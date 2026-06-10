import { NextRequest, NextResponse } from "next/server";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { getDb } from "@/lib/db";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runLineBacklogRecovery } from "@/lib/line/backlog-recovery";

// 1,962 contacts scanned + in-memory matching; well within 300s for the matching phase.
// runLineFollowersReanchor is NOT called here — C2 is backlog-recovery-only.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;

  return withCronInvocationAudit(
    { jobKey: "line_backlog_recovery", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await runLineBacklogRecovery({ db: getDb(), dryRun: false });
        return NextResponse.json({ ok: true, result });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "LINE backlog recovery failed";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  );
}
