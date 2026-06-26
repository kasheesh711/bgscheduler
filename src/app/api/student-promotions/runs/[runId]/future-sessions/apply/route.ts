import { NextRequest, NextResponse } from "next/server";
import {
  applyStudentPromotionFutureSessionActions,
  WISE_SESSION_SUBJECT_UPDATE_CONFIRMATION,
} from "@/lib/student-promotions/data";
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
    if (body?.confirm !== WISE_SESSION_SUBJECT_UPDATE_CONFIRMATION) {
      return NextResponse.json({ error: "Future session subject apply confirmation is required" }, { status: 400 });
    }
    return NextResponse.json({
      detail: await applyStudentPromotionFutureSessionActions({ runId, actor }),
    });
  } catch (error) {
    return studentPromotionErrorResponse(
      "/api/student-promotions/runs/[runId]/future-sessions/apply",
      error,
      "Student promotion future session apply failed",
    );
  }
}
