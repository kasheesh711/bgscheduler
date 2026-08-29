import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import {
  applyPostClassReviewAction,
  POST_CLASS_WAIVER_CATEGORIES,
} from "@/lib/post-class-feedback/actions";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";

const BodySchema = z.object({
  deductionId: z.string().uuid(),
  action: z.enum(["approve", "waive", "reopen", "reinstate"]),
  note: z.string().max(2_000).default(""),
  waiverCategory: z.enum(POST_CLASS_WAIVER_CATEGORIES).optional(),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(250),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("reviewer");
    const deduction = await applyPostClassReviewAction(actor, BodySchema.parse(await request.json()));
    return NextResponse.json({ ok: true, deduction });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/review",
      error,
      "Could not update the review decision.",
    );
  }
}
