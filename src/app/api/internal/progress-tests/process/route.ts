import { getCronSecretStatus } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { processJobs } from "@/lib/progress-tests/workspace/jobs";
import type { NextRequest } from "next/server";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  if (getCronSecretStatus(request) !== "valid") return Response.json({ error: "Unauthorized" }, { status: 401 });
  return withCronInvocationAudit({ jobKey: "progress_tests_processing", triggerSource: "cron", requestMethod: "GET" }, async () => Response.json(await processJobs()));
}
