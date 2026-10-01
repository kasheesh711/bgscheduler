import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { recordStillWithUs } from "@/lib/tutor-offboarding/decisions";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { findPersonRow } from "@/lib/tutor-offboarding/service";

const DecisionBody = z.object({
  canonicalKey: z.string().trim().min(1).max(200),
  note: z.string().trim().max(1_000).nullish(),
  snoozeDays: z.union([z.literal(90), z.literal(365)]),
}).strict();

/** "Still with us": hides a person from the review list for 90 days or a year. The score is computed here, never sent by the client. */
export async function POST(request: NextRequest) {
  try {
    const viewer = await requireTutorOffboardingAdmin();
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      throw new TutorOffboardingError("Invalid JSON body.", 400);
    }
    const parsed = DecisionBody.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const row = await findPersonRow(viewer, parsed.data.canonicalKey);
    if (!row) throw new TutorOffboardingError("This tutor is not on the review page.", 404);
    const decision = await recordStillWithUs(getDb(), {
      canonicalKey: row.signals.canonicalKey,
      note: parsed.data.note ? parsed.data.note : null,
      snoozeDays: parsed.data.snoozeDays,
      actorEmail: viewer.email,
      score: { likelihood: row.score.likelihood, band: row.score.band, reasons: row.score.reasons.map((reason) => reason.text) },
    });
    return NextResponse.json({ ok: true, decision });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] decision failed", error, "The decision could not be saved.");
  }
}
