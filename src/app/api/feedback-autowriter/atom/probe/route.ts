import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { feedbackAutowriterErrorResponse } from "@/lib/feedback-autowriter/api";
import { collectAtomOnServer } from "@/lib/feedback-autowriter/atom/collector";

export const maxDuration = 750;
/** Fresh browser login and completed-activity read on the deployed server. Never approves links or posts. */
export async function POST(request: NextRequest) {
  try {
    await requireClassroomOperationsOwner();
    const body = z.object({ studentId: z.string().regex(/^_[0-9]+$/u), date: z.iso.date() }).strict().parse(await request.json());
    const result = await collectAtomOnServer("admin", body);
    return NextResponse.json(result, { status: result.ok ? 200 : 503 });
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] Atom probe failed", error, "The server login and retrieval check failed.");
  }
}
