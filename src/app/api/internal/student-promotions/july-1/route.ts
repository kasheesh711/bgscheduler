import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { applyVerifiedStudentPromotionRun } from "@/lib/student-promotions/data";
import { studentPromotionErrorResponse } from "@/lib/student-promotions/api";
import { STUDENT_PROMOTION_TARGET_DATE } from "@/lib/student-promotions/rules";

export const maxDuration = 800;

function hasValidCronSecret(request: NextRequest): "valid" | "invalid" | "missing-secret" {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return "missing-secret";

  const received = Buffer.from(request.headers.get("authorization") ?? "");
  const known = Buffer.from(`Bearer ${cronSecret}`);
  return received.length === known.length && timingSafeEqual(received, known) ? "valid" : "invalid";
}

export async function GET(request: NextRequest) {
  const secretStatus = hasValidCronSecret(request);
  if (secretStatus === "missing-secret") {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (secretStatus !== "valid") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronInvocationAudit(
    { jobKey: "student_promotions_july_1", triggerSource: "cron", requestMethod: request.method },
    async () => {
      if (todayBangkok() !== STUDENT_PROMOTION_TARGET_DATE) {
        return NextResponse.json({
          error: "Student promotion cron is only allowed on July 1, 2026 Bangkok time",
        }, { status: 409 });
      }

      try {
        return NextResponse.json({
          detail: await applyVerifiedStudentPromotionRun({ trigger: "cron" }),
        });
      } catch (error) {
        return studentPromotionErrorResponse(
          "/api/internal/student-promotions/july-1",
          error,
          "Student promotion cron failed",
        );
      }
    },
  );
}

export async function POST(request: NextRequest) {
  return GET(request);
}
