import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { applyPostClassFinanceAction } from "@/lib/post-class-feedback/actions";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";

const FinanceBase = {
  deductionId: z.string().uuid(),
  processingMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(250),
} as const;

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    ...FinanceBase,
    action: z.literal("move"),
    referenceNote: z.string().max(2_000).optional().default(""),
    reason: z.string().max(2_000).optional(),
  }),
  z.object({
    ...FinanceBase,
    action: z.literal("process"),
    referenceNote: z.string().trim().min(1).max(2_000),
    reason: z.string().max(2_000).optional(),
  }),
  z.object({
    ...FinanceBase,
    action: z.literal("reverse"),
    referenceNote: z.string().trim().min(1).max(2_000),
    reason: z.string().trim().min(1).max(2_000),
  }),
]);

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("finance");
    const deduction = await applyPostClassFinanceAction(actor, BodySchema.parse(await request.json()));
    return NextResponse.json({ ok: true, deduction });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/finance",
      error,
      "Could not update the finance handoff.",
    );
  }
}
