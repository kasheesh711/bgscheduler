import { NextRequest, NextResponse } from "next/server";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { sendDeductionReport } from "@/lib/post-class-feedback/deduction-report";

export const maxDuration = 300;
export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;
  return withCronInvocationAudit({ jobKey: "post_class_deduction_report", triggerSource: "cron", requestMethod: "GET" }, async () => {
    const result = await sendDeductionReport();
    return NextResponse.json(result, { status: result.status === "sent" ? 200 : 503 });
  });
}
