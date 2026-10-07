import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { getDb } from "@/lib/db";
import { AutowriterReviewError, feedbackAutowriterErrorResponse } from "@/lib/feedback-autowriter/api";
import { postNoShowNote } from "@/lib/feedback-autowriter/no-show-post";
import { createWiseFeedbackOps, loadFieldMappings } from "@/lib/feedback-autowriter/run";

export const maxDuration = 60;

const PostBody = z.object({
  action: z.literal("post_note"),
  wiseSessionId: z.string().regex(/^[a-f0-9]{24}$/u),
}).strict();

/**
 * Owner one click on a held no-show class: post the standard no-show note to Wise (`postNoShowNote` re-checks every
 * guard on a fresh read and re-sends Wise's billing unchanged). The only Wise write is that one feedback POST.
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
    const parsed = PostBody.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const result = await postNoShowNote(getDb(), {
      wiseSessionId: parsed.data.wiseSessionId, actor: actor.email, ops: createWiseFeedbackOps(), loadMappings: loadFieldMappings,
    });
    return result.ok ? NextResponse.json(result) : NextResponse.json({ error: result.reason }, { status: result.status });
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] no-show note failed", error, "The no-show note could not be posted.");
  }
}
