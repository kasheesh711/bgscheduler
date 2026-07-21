import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { reviewPostClassAiConcerns } from "@/lib/post-class-feedback/ai";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";

const BodySchema = z.object({
  concernId: z.string().uuid(),
  action: z.enum(["confirm", "dismiss"]),
  note: z.string().trim().min(1).max(2_000),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(250),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("reviewer");
    const result = await reviewPostClassAiConcerns(actor.email, BodySchema.parse(await request.json()));
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/ai-review",
      error,
      "Could not record the AI concern review.",
    );
  }
}
