import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { isMissingSchemaError, TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { getRemovalRun } from "@/lib/tutor-offboarding/removal";

const RunId = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    await requireTutorOffboardingAdmin();
    const { runId } = await context.params;
    if (!RunId.safeParse(runId).success) throw new TutorOffboardingError("That removal run was not found.", 404);
    const run = await getRemovalRun(runId);
    if (!run) throw new TutorOffboardingError("That removal run was not found.", 404);
    return NextResponse.json({ run });
  } catch (error) {
    if (isMissingSchemaError(error)) return NextResponse.json({ available: false, reason: "not_set_up" });
    return tutorOffboardingErrorResponse("[tutor-offboarding] removal run read failed", error, "Removal run details could not load.");
  }
}
