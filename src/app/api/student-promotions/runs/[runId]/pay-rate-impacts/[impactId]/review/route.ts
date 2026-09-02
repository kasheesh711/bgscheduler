import { NextRequest, NextResponse } from "next/server";
import {
  reviewStudentPromotionPayRateImpact,
  type StudentPromotionPayRateReviewStatus,
} from "@/lib/student-promotions/data";
import {
  requireStudentPromotionRunId,
  requireStudentPromotionSession,
  studentPromotionErrorResponse,
  type StudentPromotionRouteContext,
} from "@/lib/student-promotions/api";

interface PayRateImpactRouteContext extends StudentPromotionRouteContext {
  params: Promise<unknown>;
}

async function requirePayRateImpactId(context: PayRateImpactRouteContext): Promise<string> {
  const params = await context.params;
  if (!params || typeof params !== "object" || !("impactId" in params)) {
    throw new Error("Pay-rate impact id is required");
  }
  const impactId = (params as { impactId?: unknown }).impactId;
  if (typeof impactId !== "string" || !impactId.trim()) {
    throw new Error("Pay-rate impact id is required");
  }
  return impactId;
}

function parseReviewStatus(value: unknown): StudentPromotionPayRateReviewStatus {
  if (value === "verified_correct" || value === "incorrect") return value;
  throw new Error("Pay-rate review status must be verified_correct or incorrect");
}

export async function PATCH(
  request: NextRequest,
  context: PayRateImpactRouteContext,
) {
  try {
    const actor = await requireStudentPromotionSession();
    const runId = await requireStudentPromotionRunId(context);
    const impactId = await requirePayRateImpactId(context);
    const body = await request.json().catch(() => ({}));
    const status = parseReviewStatus(body?.status);
    const note = typeof body?.note === "string" ? body.note : null;

    return NextResponse.json({
      detail: await reviewStudentPromotionPayRateImpact({
        runId,
        impactId,
        status,
        note,
        actor,
      }),
    });
  } catch (error) {
    return studentPromotionErrorResponse(
      "/api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review",
      error,
      "Student promotion pay-rate review failed",
    );
  }
}
