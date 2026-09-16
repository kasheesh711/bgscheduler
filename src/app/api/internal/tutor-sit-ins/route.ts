import { NextRequest } from "next/server";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { sitInError, sitInJson } from "@/lib/tutor-sit-ins/http";
import { runSitInWorker } from "@/lib/tutor-sit-ins/worker";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;
  return withCronInvocationAudit(
    {
      jobKey: "tutor_sit_ins",
      triggerSource: "cron",
      requestMethod: request.method,
    },
    async () => {
      try {
        const result = await runSitInWorker();
        return sitInJson(result, result.ok ? 200 : 500);
      } catch (e) {
        return sitInError(e);
      }
    },
  );
}
