import { NextRequest, NextResponse } from "next/server";
import {
  updateStudentPromotionGraduationDisposition,
  type StudentPromotionGraduationDisposition,
} from "@/lib/student-promotions/data";
import {
  requireStudentPromotionRunId,
  requireStudentPromotionSession,
  studentPromotionErrorResponse,
  type StudentPromotionRouteContext,
} from "@/lib/student-promotions/api";

interface GraduationActionRouteContext extends StudentPromotionRouteContext {
  params: Promise<unknown>;
}

async function requireGraduationActionId(context: GraduationActionRouteContext): Promise<string> {
  const params = await context.params;
  if (!params || typeof params !== "object" || !("actionId" in params)) {
    throw new Error("Graduation action id is required");
  }
  const actionId = (params as { actionId?: unknown }).actionId;
  if (typeof actionId !== "string" || !actionId.trim()) {
    throw new Error("Graduation action id is required");
  }
  return actionId;
}

function parseDisposition(value: unknown): StudentPromotionGraduationDisposition {
  if (value === "inactive" || value === "university") return value;
  throw new Error("Graduation disposition must be inactive or university");
}

export const maxDuration = 800;

export async function PATCH(
  request: NextRequest,
  context: GraduationActionRouteContext,
) {
  try {
    const actor = await requireStudentPromotionSession();
    const runId = await requireStudentPromotionRunId(context);
    const actionId = await requireGraduationActionId(context);
    const body = await request.json().catch(() => ({}));
    const disposition = parseDisposition(body?.disposition);

    return NextResponse.json({
      detail: await updateStudentPromotionGraduationDisposition({
        runId,
        actionId,
        disposition,
        actor,
      }),
    });
  } catch (error) {
    return studentPromotionErrorResponse(
      "/api/student-promotions/runs/[runId]/graduation-actions/[actionId]",
      error,
      "Student promotion graduation update failed",
    );
  }
}
