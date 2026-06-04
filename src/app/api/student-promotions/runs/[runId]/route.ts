import { NextRequest, NextResponse } from "next/server";
import { getStudentPromotionRunDetail } from "@/lib/student-promotions/data";
import {
  requireStudentPromotionRunId,
  requireStudentPromotionSession,
  studentPromotionErrorResponse,
  type StudentPromotionRouteContext,
} from "@/lib/student-promotions/api";

export async function GET(
  _request: NextRequest,
  context: StudentPromotionRouteContext,
) {
  try {
    await requireStudentPromotionSession();
    const runId = await requireStudentPromotionRunId(context);
    return NextResponse.json({ detail: await getStudentPromotionRunDetail(runId) });
  } catch (error) {
    return studentPromotionErrorResponse("/api/student-promotions/runs/[runId]", error, "Failed to load student promotion run");
  }
}
