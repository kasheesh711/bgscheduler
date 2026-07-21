import { NextRequest, NextResponse } from "next/server";

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { sendPostClassAdminDigest } from "@/lib/post-class-feedback/notifications";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit(
    { jobKey: "post_class_feedback_digest", triggerSource: "cron", requestMethod: request.method },
    async () => {
      try {
        const digest = await sendPostClassAdminDigest();
        return NextResponse.json({ ok: true, digest });
      } catch {
        return NextResponse.json({ error: "Post-class feedback digest job failed" }, { status: 500 });
      }
    },
  );
}
