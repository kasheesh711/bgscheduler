import { NextRequest, NextResponse } from "next/server";
import { verifyStudentPromotionRun } from "@/lib/student-promotions/data";
import {
  requireStudentPromotionRunId,
  requireStudentPromotionSession,
  studentPromotionErrorResponse,
  type StudentPromotionRouteContext,
} from "@/lib/student-promotions/api";

export async function POST(
  request: NextRequest,
  context: StudentPromotionRouteContext,
) {
  try {
    const actor = await requireStudentPromotionSession();
    const runId = await requireStudentPromotionRunId(context);
    const body = await request.json().catch(() => ({}));
    const endpointVerificationConfirmed = body?.endpointVerificationConfirmed === true;
    const endpointVerificationNote = typeof body?.endpointVerificationNote === "string"
      ? body.endpointVerificationNote
      : "";

    if (!endpointVerificationConfirmed) {
      return NextResponse.json({ error: "Endpoint verification confirmation is required" }, { status: 400 });
    }

    return NextResponse.json({
      detail: await verifyStudentPromotionRun({ runId, actor, endpointVerificationNote }),
    });
  } catch (error) {
    return studentPromotionErrorResponse(
      "/api/student-promotions/runs/[runId]/verify",
      error,
      "Student promotion verification failed",
    );
  }
}
