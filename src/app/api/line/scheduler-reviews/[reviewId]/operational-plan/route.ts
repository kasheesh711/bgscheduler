import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  getLineMessageForProcessing,
  getLineSchedulerReview,
  patchLineSchedulerOperationalPlan,
} from "@/lib/line/data";
import { buildLineOperationalReviewPlan } from "@/lib/line/operational";

type RouteContext = { params: Promise<{ reviewId: string }> };

export async function POST(_request: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { reviewId } = await ctx.params;
  const db = getDb();
  const review = await getLineSchedulerReview(db, reviewId);
  if (!review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }
  if (review.status !== "pending_review") {
    return NextResponse.json({ error: "Only pending reviews can be rebuilt" }, { status: 400 });
  }

  const lineMessage = await getLineMessageForProcessing(db, review.inboundMessageId);
  if (!lineMessage) {
    return NextResponse.json({ error: "Inbound LINE message not found" }, { status: 404 });
  }

  const plan = await buildLineOperationalReviewPlan({
    db,
    contactId: review.contactId,
    messageText: lineMessage.text,
    classifierCategory: review.classifierCategory,
  });
  const updated = await patchLineSchedulerOperationalPlan(db, review.id, {
    intentType: plan.intentType,
    intentPayload: plan.intentPayload as unknown as Record<string, unknown>,
    proposedDraft: plan.proposedDraft || review.proposedDraft,
    matchedStudentKeys: plan.matchedStudentKeys,
    candidateSessions: plan.candidateSessions as unknown as Record<string, unknown>[],
    proposedWiseActions: plan.proposedWiseActions as unknown as Record<string, unknown>[],
    adminSelectedSessionIds: plan.adminSelectedSessionIds,
    writebackStatus: plan.writebackStatus,
  });

  return NextResponse.json({ review: updated });
}
