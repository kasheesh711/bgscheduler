import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { getDb } from "@/lib/db";
import { AutowriterReviewError, feedbackAutowriterErrorResponse } from "@/lib/feedback-autowriter/api";
import { postNoShowNote } from "@/lib/feedback-autowriter/no-show-post";
import { autowriterEnabled, autowriterWritesAllowedHere, wiseApiActorId } from "@/lib/feedback-autowriter/config";
import { createWiseFeedbackOps, loadFieldMappings } from "@/lib/feedback-autowriter/run";

/** The guarded POST's reads, its 60 s POST and the read-back fit, with room before the platform stops the function. */
export const maxDuration = 300;
const BUDGET_MS = 280_000;

const PostBody = z.object({
  action: z.literal("post_note"),
  wiseSessionId: z.string().regex(/^[a-f0-9]{24}$/u),
}).strict();

/**
 * Owner one click on a held no-show class: post the standard no-show note to Wise through the autowriter's guarded
 * POST (`postNoShowNote`). The only Wise write is that one feedback POST; never from a preview deployment, never with
 * the autowriter switched off.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const actor = await requireClassroomOperationsOwner();
    if (!autowriterEnabled() || !autowriterWritesAllowedHere()) {
      throw new AutowriterReviewError("Posting from here is switched off (autowriter disabled, or a preview deployment).", 409);
    }
    const apiActorId = wiseApiActorId();
    if (!apiActorId) throw new AutowriterReviewError("WISE_USER_ID is not set.", 409);
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      throw new AutowriterReviewError("Invalid JSON body.", 400);
    }
    const parsed = PostBody.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const result = await postNoShowNote(getDb(), {
      wiseSessionId: parsed.data.wiseSessionId, actor: actor.email, apiActorId, ops: createWiseFeedbackOps(), loadMappings: loadFieldMappings,
      remainingMs: () => BUDGET_MS - (Date.now() - startedAt),
    });
    return result.ok ? NextResponse.json(result) : NextResponse.json({ error: result.reason }, { status: result.status });
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] no-show note failed", error, "The no-show note could not be posted.");
  }
}
