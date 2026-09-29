import { NextRequest } from "next/server";

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { runPostClassCollectionTickRequest } from "@/lib/post-class-feedback/collection-tick";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit(
    { jobKey: "post_class_feedback", triggerSource: "cron", requestMethod: request.method },
    // The same tick as Data Health's Run and the page's collect mode.
    () => runPostClassCollectionTickRequest({ triggerType: "cron" }),
  );
}
