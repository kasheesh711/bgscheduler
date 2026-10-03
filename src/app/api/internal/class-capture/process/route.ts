import { type NextRequest, NextResponse } from "next/server";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { processAutomaticQueue } from "@/lib/class-capture/automatic";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit({ jobKey: "class_capture_processing", triggerSource: "cron", requestMethod: "GET" }, async () => {
    try { return NextResponse.json({ ok: true, ...await processAutomaticQueue() }); }
    catch { return NextResponse.json({ ok: false, error: "Class Capture processing could not finish." }, { status: 503 }); }
  });
}
