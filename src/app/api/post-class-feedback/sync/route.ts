import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { processPostClassAiReviews } from "@/lib/post-class-feedback/ai";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { processDuePostClassNotificationRetries } from "@/lib/post-class-feedback/notifications";
import { runPostClassFeedbackSync } from "@/lib/post-class-feedback/sync";

export const maxDuration = 800;

const BangkokDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, "Invalid calendar date");

const BodySchema = z.object({
  detailCap: z.number().int().min(1).max(50).optional(),
  startDate: BangkokDateSchema.optional(),
  endDate: BangkokDateSchema.optional(),
}).strict().refine((value) => Boolean(value.startDate) === Boolean(value.endDate), {
  message: "startDate and endDate must be supplied together",
}).refine((value) => !value.startDate || !value.endDate || value.startDate <= value.endDate, {
  message: "startDate must not be after endDate",
}).default({});

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("access_manager");
    const input = BodySchema.parse(await request.json().catch(() => ({})));
    const result = await runPostClassFeedbackSync({
      triggerType: "manual",
      actorEmail: actor.email,
      detailCap: input.detailCap,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    const [ai, retries] = await Promise.allSettled([
      processPostClassAiReviews(),
      processDuePostClassNotificationRetries(),
    ]);
    return NextResponse.json({
      ok: true,
      result,
      ai: ai.status === "fulfilled" ? ai.value : { failed: true },
      retries: retries.status === "fulfilled" ? retries.value : { failed: true },
    });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/sync",
      error,
      "Could not sync post-class feedback.",
    );
  }
}
