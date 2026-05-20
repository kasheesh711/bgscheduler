import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  acceptLineSchedulerReviewNoSend,
  approveLineSchedulerReview,
  dismissLineSchedulerReview,
  rejectLineSchedulerReview,
} from "@/lib/line/review-service";

const patchReviewSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve_send"),
    finalText: z.string().trim().min(1).max(5000),
  }).strict(),
  z.object({
    action: z.literal("accept_no_send"),
    finalText: z.string().trim().max(5000).optional(),
  }).strict(),
  z.object({
    action: z.literal("reject"),
    rejectionReason: z.string().trim().min(1).max(500),
    staffCorrection: z.string().trim().min(1).max(5000),
  }).strict(),
  z.object({
    action: z.literal("dismiss"),
    rejectionReason: z.string().trim().max(500).optional(),
  }).strict(),
]);

type ReviewRouteContext = { params: Promise<{ reviewId: string }> };

function actorFromSession(session: { user?: { email?: string | null; name?: string | null } } | null) {
  return {
    email: session?.user?.email ?? null,
    name: session?.user?.name ?? null,
  };
}

async function reviewIdFromContext(ctx: ReviewRouteContext) {
  const params = await ctx.params;
  return params.reviewId;
}

export async function PATCH(
  request: NextRequest,
  ctx: ReviewRouteContext,
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = patchReviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();
  const reviewId = await reviewIdFromContext(ctx);
  const actor = actorFromSession(session);

  try {
    const review = parsed.data.action === "approve_send"
      ? await approveLineSchedulerReview({
        db,
        reviewId,
        finalText: parsed.data.finalText,
        actor,
      })
      : parsed.data.action === "accept_no_send"
        ? await acceptLineSchedulerReviewNoSend({
          db,
          reviewId,
          finalText: parsed.data.finalText,
          actor,
        })
        : parsed.data.action === "reject"
          ? await rejectLineSchedulerReview({
            db,
            reviewId,
            rejectionReason: parsed.data.rejectionReason,
            staffCorrection: parsed.data.staffCorrection,
            actor,
          })
          : await dismissLineSchedulerReview({
            db,
            reviewId,
            rejectionReason: parsed.data.rejectionReason,
            actor,
          });

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    return NextResponse.json({ review });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update review";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
