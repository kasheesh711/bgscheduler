import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { feedbackAutowriterErrorResponse } from "@/lib/feedback-autowriter/api";
import { approveIsebComparisons, confirmUnattendedAtomProof } from "@/lib/feedback-autowriter/iseb-rollout";
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve_comparisons"), comparisonHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  z.object({ action: z.literal("confirm_unattended_run"), runId: z.string().uuid(), codexAndComputerWereOff: z.literal(true) }).strict(),
]);
export async function POST(request: NextRequest) {
  try {
    const actor = await requireClassroomOperationsOwner();
    const body = Body.parse(await request.json());
    if (body.action === "approve_comparisons") await approveIsebComparisons(getDb(), body.comparisonHash, actor.email);
    else await confirmUnattendedAtomProof(getDb(), body.runId, actor.email);
    return NextResponse.json({ ok: true });
  } catch (error) { return feedbackAutowriterErrorResponse("[feedback-autowriter] rollout approval failed", error, "Rollout approval could not be saved."); }
}
