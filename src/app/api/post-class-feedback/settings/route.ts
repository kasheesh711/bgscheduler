import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { updatePostClassSettings } from "@/lib/post-class-feedback/settings";

const BodySchema = z.object({
  reminderMode: z.enum(["off", "shadow", "live"]).optional(),
  reminderActivationAt: z.string().datetime({ offset: true }).optional(),
  legacyReminderDisabled: z.boolean().optional(),
  mode: z.enum(["shadow", "live", "paused"]).optional(),
  effectiveAt: z.string().trim().min(1).nullable().optional(),
  mapping: z.object({
    topics: z.string().nullable().optional(),
    performance: z.string().nullable().optional(),
    improvement: z.string().nullable().optional(),
    homework: z.string().nullable().optional(),
  }).optional(),
  digestRecipientEmails: z.array(z.string().email()).max(100).optional(),
  expectedVersion: z.number().int().positive(),
});

export async function PATCH(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("access_manager");
    const settings = await updatePostClassSettings(actor, BodySchema.parse(await request.json()));
    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "PATCH /api/post-class-feedback/settings",
      error,
      "Could not update post-class feedback settings.",
    );
  }
}
