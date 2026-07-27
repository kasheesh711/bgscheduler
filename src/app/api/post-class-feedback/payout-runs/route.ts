import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { previewPayoutRun, publishPayoutRun } from "@/lib/post-class-feedback/payout-run";

// A publish paces itself against Google's write quota — roughly 27 lines a
// minute — and stops cleanly at its own ten-minute budget well inside this.
export const maxDuration = 800;

const AnchorMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, "Expected YYYY-MM");

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("preview"),
    anchorMonth: AnchorMonth,
  }),
  z.object({
    action: z.literal("publish"),
    anchorMonth: AnchorMonth,
    expectedVersion: z.number().int().positive(),
    // Counts, not booleans: an acknowledgement has to echo the exact number the
    // operator was shown, so a stale tab cannot wave through a number that has
    // grown since it rendered.
    acknowledgements: z.object({
      pendingReviewDeductions: z.number().int().min(0).optional(),
      unavailableSessions: z.number().int().min(0).optional(),
    }).strict().optional(),
  }),
]);

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("finance");
    const body = BodySchema.parse(await request.json());
    const view = body.action === "preview"
      ? await previewPayoutRun(actor, { anchorMonth: body.anchorMonth })
      : await publishPayoutRun(actor, {
        anchorMonth: body.anchorMonth,
        expectedVersion: body.expectedVersion,
        acknowledgements: body.acknowledgements,
      });
    return NextResponse.json({ ok: true, ...view });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/payout-runs",
      error,
      "Could not run the payout publish.",
    );
  }
}
