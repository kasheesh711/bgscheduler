import { type NextRequest, NextResponse } from "next/server";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { collectAtomOnServer } from "@/lib/feedback-autowriter/atom/collector";

export const maxDuration = 750;

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit({ jobKey: "feedback_atom", triggerSource: "cron", requestMethod: "GET" }, async () => {
    try {
      const result = await collectAtomOnServer();
      return NextResponse.json(result, { status: result.ok ? 200 : 503 });
    } catch {
      return NextResponse.json({ ok: false, error: "Atom collection could not complete." }, { status: 503 });
    }
  });
}
