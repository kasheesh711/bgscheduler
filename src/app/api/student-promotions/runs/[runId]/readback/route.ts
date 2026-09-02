import { NextRequest, NextResponse } from "next/server";
import { runStudentPromotionReadback } from "@/lib/student-promotions/data";
import {
  requireStudentPromotionRunId,
  requireStudentPromotionSession,
  studentPromotionErrorResponse,
  type StudentPromotionRouteContext,
} from "@/lib/student-promotions/api";

export const maxDuration = 800;

export async function POST(
  _request: NextRequest,
  context: StudentPromotionRouteContext,
) {
  try {
    await requireStudentPromotionSession();
    const runId = await requireStudentPromotionRunId(context);
    return NextResponse.json({
      readback: await runStudentPromotionReadback({ runId }),
    });
  } catch (error) {
    return studentPromotionErrorResponse(
      "/api/student-promotions/runs/[runId]/readback",
      error,
      "Student promotion readback failed",
    );
  }
}
