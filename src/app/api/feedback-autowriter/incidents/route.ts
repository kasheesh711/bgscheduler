import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { getDb } from "@/lib/db";
import { AutowriterReviewError, feedbackAutowriterErrorResponse } from "@/lib/feedback-autowriter/api";
import { acknowledgeIncident } from "@/lib/feedback-autowriter/incidents";

const AcknowledgeBody = z.object({
  action: z.literal("acknowledge"),
  incidentId: z.uuid(),
}).strict();

/**
 * Owner acknowledgement of an autowriter incident: its pushes stop, and an undelivered critical incident no longer
 * keeps the review job red. Idempotent. Never writes to Wise.
 */
export async function POST(request: NextRequest) {
  try {
    const actor = await requireClassroomOperationsOwner();
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      throw new AutowriterReviewError("Invalid JSON body.", 400);
    }
    const parsed = AcknowledgeBody.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const acknowledged = await acknowledgeIncident(getDb(), { incidentId: parsed.data.incidentId, actor: actor.email });
    if (!acknowledged) throw new AutowriterReviewError("No incident with that id.", 404);
    return NextResponse.json({ ok: true, ...acknowledged });
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] incident acknowledgement failed", error, "The incident could not be acknowledged.");
  }
}
