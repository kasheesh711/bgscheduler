import { NextRequest } from "next/server";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { sitInError, sitInJson } from "@/lib/tutor-sit-ins/http";
import { queueDailyDigests, processJobs } from "@/lib/tutor-sit-ins/worker";
import { getDb } from "@/lib/db";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;
  return withCronInvocationAudit(
    {
      jobKey: "tutor_sit_ins_digest",
      triggerSource: "cron",
      requestMethod: request.method,
    },
    async () => {
      try {
        await queueDailyDigests();
        const result = await processJobs(getDb(), {
          limit: 50,
          deadlineAt: Date.now() + 270_000,
        });
        return sitInJson(result, result.failed ? 500 : 200);
      } catch (e) {
        return sitInError(e);
      }
    },
  );
}
