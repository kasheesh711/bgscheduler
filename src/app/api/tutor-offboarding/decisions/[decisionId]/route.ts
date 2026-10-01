import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { revokeDecision } from "@/lib/tutor-offboarding/decisions";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";

type DecisionRouteContext = { params: Promise<{ decisionId: string }> };

/** Undo a "Still with us" decision; the person returns to the review list if still idle. */
export async function DELETE(_request: NextRequest, context: DecisionRouteContext) {
  try {
    const viewer = await requireTutorOffboardingAdmin();
    const { decisionId } = await context.params;
    if (!z.uuid().safeParse(decisionId).success) throw new TutorOffboardingError("That decision was not found.", 404);
    const decision = await revokeDecision(getDb(), { decisionId, actorEmail: viewer.email });
    return NextResponse.json({ ok: true, decision });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] undo failed", error, "The decision could not be undone.");
  }
}
