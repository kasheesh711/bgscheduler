import { NextResponse, type NextRequest } from "next/server";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { hiringError } from "@/lib/hiring/http";
import { runResumeRetention } from "@/lib/hiring/resume-files";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";

export const maxDuration = 60;
export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;
  return withCronInvocationAudit(
    { jobKey: "hiring_resume_retention", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        return NextResponse.json({ deleted: await runResumeRetention() });
      } catch (error) {
        return hiringError(error);
      }
    },
  );
}
