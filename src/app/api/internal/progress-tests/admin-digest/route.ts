import { NextRequest, NextResponse } from "next/server";
import { sendProgressTestAdminDigest } from "@/lib/progress-tests/admin-digest";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;

  return withCronInvocationAudit(
    { jobKey: "progress_tests_digest", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const result = await sendProgressTestAdminDigest();
        const status = result.status === "failed" ? 500 : 200;
        return NextResponse.json(result, { status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Progress test admin digest failed";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  );
}
