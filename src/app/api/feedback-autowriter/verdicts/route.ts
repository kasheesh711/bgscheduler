import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { getDb } from "@/lib/db";
import { AutowriterReviewError, feedbackAutowriterErrorResponse } from "@/lib/feedback-autowriter/api";
import { recordVerdict, verdictShapeProblem } from "@/lib/feedback-autowriter/verdicts";

const VerdictBody = z.object({
  wiseSessionId: z.string().regex(/^[0-9a-f]{24}$/iu),
  /** The first shot's fields_sha256 the owner was shown. */
  fieldsSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  /** The current verdict the page showed (null: none) — a newer one makes the page stale (409). */
  currentVerdictId: z.uuid().nullable(),
  /** The open flags the page showed — only these are resolved; any other open flag makes the page stale (409). */
  seenFlagIds: z.array(z.uuid()).max(100),
  verdict: z.enum(["approve", "needs_fix"]),
  severity: z.enum(["cosmetic", "factual", "critical"]).nullish(),
  criticalCategory: z.enum(["wrong_person", "billing_status", "invented_content", "should_not_have_posted"]).nullish(),
  note: z.string().trim().max(2_000).nullish(),
  /** The owner confirmed replacing a harsher judgement (critical, or major) with a milder verdict (a note is then required). */
  confirmDowngrade: z.boolean().optional(),
}).strict();

/**
 * Owner verdict on a posted class's first shot (Approve / Needs fix with severity, category and note). Appends
 * the verdict and makes it current in one transaction; a critical verdict queues a critical incident. Never
 * writes to Wise.
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
    const parsed = VerdictBody.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const input = {
      ...parsed.data,
      severity: parsed.data.severity ?? null,
      criticalCategory: parsed.data.criticalCategory ?? null,
      note: parsed.data.note ? parsed.data.note : null,
    };
    const problem = verdictShapeProblem(input);
    if (problem) throw new AutowriterReviewError(problem, 400);
    const recorded = await recordVerdict(getDb(), { ...input, reviewer: actor.email, source: "dashboard" });
    return NextResponse.json({ ok: true, ...recorded });
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] verdict failed", error, "The verdict could not be recorded.");
  }
}
