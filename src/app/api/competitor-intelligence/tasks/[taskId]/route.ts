import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  competitorIntelligenceErrorResponse,
  requireCompetitorIntelligenceSession,
} from "@/lib/competitor-intelligence/access";
import { updateCompetitorTask } from "@/lib/competitor-intelligence/data";

const PatchSchema = z.object({
  status: z.enum(["todo", "in_progress", "blocked", "done", "ignored"]).optional(),
  ownerEmail: z.string().email().nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
});

type TaskRouteContext = { params: Promise<{ taskId: string }> };

export async function PATCH(request: NextRequest, ctx: TaskRouteContext) {
  try {
    const user = await requireCompetitorIntelligenceSession();
    const { taskId } = await ctx.params;
    const input = PatchSchema.parse(await request.json());
    const task = await updateCompetitorTask(taskId, input, user.email);
    return NextResponse.json({ task });
  } catch (error) {
    return competitorIntelligenceErrorResponse(error, "Failed to update competitor task");
  }
}
