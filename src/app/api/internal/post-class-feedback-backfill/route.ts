import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { runPostClassBackfillJob } from "@/lib/post-class-feedback/backfill-job";
import { findOldestUnreconciledBackfillWindow } from "@/lib/post-class-feedback/backfill-window";
import {
  PostClassFeedbackSyncAlreadyRunningError,
} from "@/lib/post-class-feedback/repository";

export const maxDuration = 800;

// The rolling collector only covers the last four days. This drains history:
// each run takes the oldest window that is still unreconciled and works it
// until the pool is empty or the run's budget is spent, so repeated runs
// converge without anyone choosing dates by hand. An explicit start/end
// overrides the automatic choice for a targeted re-drain.
const BangkokDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected YYYY-MM-DD");

const QuerySchema = z.object({
  startDate: BangkokDateSchema.optional(),
  endDate: BangkokDateSchema.optional(),
  detailCap: z.coerce.number().int().min(1).max(400).optional(),
  maxBatches: z.coerce.number().int().min(1).max(50).optional(),
}).refine((value) => Boolean(value.startDate) === Boolean(value.endDate), {
  message: "startDate and endDate must be supplied together",
}).refine((value) => !value.startDate || !value.endDate || value.startDate <= value.endDate, {
  message: "startDate must not be after endDate",
});

export async function GET(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;

  const parsed = QuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  return withCronInvocationAudit(
    {
      jobKey: "post_class_feedback_backfill",
      triggerSource: "cron",
      requestMethod: request.method,
    },
    async () => {
      try {
        const window = parsed.data.startDate && parsed.data.endDate
          ? { startDate: parsed.data.startDate, endDate: parsed.data.endDate }
          : await findOldestUnreconciledBackfillWindow();
        if (!window) {
          return NextResponse.json({
            ok: true,
            skipped: "nothing-unreconciled",
          });
        }

        const result = await runPostClassBackfillJob({
          startDate: window.startDate,
          endDate: window.endDate,
          // 400 is the ceiling a manual backfill is allowed; the rolling cron
          // stays at 50 so routine runs never monopolise the Wise API.
          detailCap: parsed.data.detailCap ?? 400,
          maxBatches: parsed.data.maxBatches,
        });
        return NextResponse.json({ ok: true, window, result });
      } catch (error) {
        if (error instanceof PostClassFeedbackSyncAlreadyRunningError) {
          return NextResponse.json({ error: error.message }, { status: 409 });
        }
        return NextResponse.json(
          { error: "Post-class feedback backfill failed" },
          { status: 500 },
        );
      }
    },
  );
}
