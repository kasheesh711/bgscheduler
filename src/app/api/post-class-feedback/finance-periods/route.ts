import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { changePostClassFinancePeriod } from "@/lib/post-class-feedback/actions";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";

const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const BodySchema = z.discriminatedUnion("action", [
  z.object({
    month: MonthSchema,
    action: z.literal("open"),
    reason: z.string().max(2_000).optional(),
    idempotencyKey: z.string().trim().min(1).max(250),
  }),
  z.object({
    month: MonthSchema,
    action: z.enum(["close", "reopen"]),
    reason: z.string().max(2_000).optional(),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(1).max(250).optional(),
  }),
]);

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("finance");
    const period = await changePostClassFinancePeriod(actor, BodySchema.parse(await request.json()));
    return NextResponse.json({ ok: true, period });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/finance-periods",
      error,
      "Could not update the finance period.",
    );
  }
}
