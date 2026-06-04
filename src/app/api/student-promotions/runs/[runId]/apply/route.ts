import { NextRequest, NextResponse } from "next/server";
import { applyVerifiedStudentPromotionRun } from "@/lib/student-promotions/data";
import {
  requireStudentPromotionRunId,
  requireStudentPromotionSession,
  studentPromotionErrorResponse,
  type StudentPromotionRouteContext,
} from "@/lib/student-promotions/api";

export const maxDuration = 800;

export async function POST(
  request: NextRequest,
  context: StudentPromotionRouteContext,
) {
  try {
    const actor = await requireStudentPromotionSession();
    const runId = await requireStudentPromotionRunId(context);
    const body = await request.json().catch(() => ({}));
    if (body?.confirm !== "apply-student-promotions") {
      return NextResponse.json({ error: "Apply confirmation is required" }, { status: 400 });
    }
    return NextResponse.json({
      detail: await applyVerifiedStudentPromotionRun({ runId, actor, trigger: "admin" }),
    });
  } catch (error) {
    return studentPromotionErrorResponse(
      "/api/student-promotions/runs/[runId]/apply",
      error,
      "Student promotion apply failed",
    );
  }
}
