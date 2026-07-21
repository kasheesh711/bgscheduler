import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { PostClassConflictError } from "@/lib/post-class-feedback/errors";
import { updatePostClassTutorPrimaryEmail } from "@/lib/post-class-feedback/settings";

const BodySchema = z.object({
  tutorKey: z.string().trim().min(1).max(250),
  primaryEmail: z.string().email().nullable(),
  expectedVersion: z.number().int().nonnegative(),
});

export async function PATCH(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("access_manager");
    const input = BodySchema.parse(await request.json());
    const db = getDb();
    const [current] = await db.select({ updatedAt: schema.tutorContacts.updatedAt })
      .from(schema.tutorContacts)
      .where(eq(schema.tutorContacts.canonicalKey, input.tutorKey))
      .limit(1);
    if (current && Math.floor(current.updatedAt.getTime() / 1000) !== input.expectedVersion) {
      throw new PostClassConflictError();
    }
    if (!current && input.expectedVersion !== 0) throw new PostClassConflictError();
    const tutor = await updatePostClassTutorPrimaryEmail(actor, input, db);
    return NextResponse.json({ ok: true, tutor });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "PATCH /api/post-class-feedback/tutor-emails",
      error,
      "Could not update the tutor primary email.",
    );
  }
}
