import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db";
import {
  getPostClassCapabilities,
  POST_CLASS_CAPABILITIES,
  replacePostClassCapabilities,
  requirePostClassCapability,
} from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";

const BodySchema = z.object({
  email: z.string().email(),
  capability: z.enum(POST_CLASS_CAPABILITIES),
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
  note: z.string().max(2_000).optional(),
});

export async function PATCH(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("access_manager");
    const input = BodySchema.parse(await request.json());
    const db = getDb();
    const email = input.email.trim().toLowerCase();
    const current = await getPostClassCapabilities(email, db);
    const next = new Set(current);
    if (input.enabled) next.add(input.capability); else next.delete(input.capability);
    const capabilities = await replacePostClassCapabilities({
      actorEmail: actor.email,
      targetEmail: email,
      capabilities: [...next],
      expectedVersion: input.expectedVersion,
      note: input.note,
      db,
    });
    return NextResponse.json({ ok: true, capabilities });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "PATCH /api/post-class-feedback/access",
      error,
      "Could not update feature access.",
    );
  }
}
