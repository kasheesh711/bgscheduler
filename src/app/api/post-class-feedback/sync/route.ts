import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { processPostClassAiReviews } from "@/lib/post-class-feedback/ai";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { processDuePostClassNotificationRetries } from "@/lib/post-class-feedback/notifications";
import { reassessPostClassSessions } from "@/lib/post-class-feedback/reassess";
import { runPostClassFeedbackSync } from "@/lib/post-class-feedback/sync";

export const maxDuration = 800;

const BangkokDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, "Invalid calendar date");

// `collect` fetches fresh Wise detail; `reassess` re-decides verdicts from
// evidence already persisted and never touches Wise. They are separate modes
// rather than one flag because their inputs, costs, and blast radii differ
// entirely — a reassess is safe to run over the whole backlog, a collect is not.
const CollectSchema = z.object({
  mode: z.literal("collect").optional(),
  // Up to 400 is honoured only for an explicit start/end backfill window;
  // syncPostClassFeedback clamps every other trigger back to 50.
  detailCap: z.number().int().min(1).max(400).optional(),
  startDate: BangkokDateSchema.optional(),
  endDate: BangkokDateSchema.optional(),
}).strict().refine((value) => Boolean(value.startDate) === Boolean(value.endDate), {
  message: "startDate and endDate must be supplied together",
}).refine((value) => !value.startDate || !value.endDate || value.startDate <= value.endDate, {
  message: "startDate must not be after endDate",
});

const ReassessSchema = z.object({
  mode: z.literal("reassess"),
  // Defaults to false so the destructive form is always the explicit one: a
  // caller sees the full list of verdict changes before any of them is written.
  apply: z.boolean().default(false),
  timingStatuses: z.array(z.enum(["not_due", "on_time", "late", "unknown"])).min(1).optional(),
  wiseSessionIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
}).strict();

const BodySchema = z.union([ReassessSchema, CollectSchema]).default({});

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("access_manager");
    const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const input = parsed.data;

    if ("mode" in input && input.mode === "reassess") {
      const result = await reassessPostClassSessions({
        apply: input.apply,
        timingStatuses: input.timingStatuses,
        wiseSessionIds: input.wiseSessionIds,
        limit: input.limit,
      });
      console.error(
        "[post-class-reassess]",
        JSON.stringify({
          actor: actor.email,
          apply: input.apply,
          scanned: result.scanned,
          changed: result.changed,
          deductionsWaived: result.deductionsWaived,
          failed: result.failed,
        }),
      );
      return NextResponse.json({ ok: true, mode: "reassess", applied: input.apply, result });
    }

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
