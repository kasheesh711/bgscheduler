import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  competitorIntelligenceErrorResponse,
  requireCompetitorIntelligenceSession,
} from "@/lib/competitor-intelligence/access";
import { updateCompetitorSourceStatus } from "@/lib/competitor-intelligence/data";

const PatchSchema = z.object({
  status: z.enum(["active", "disabled", "needs_review", "archived"]),
});

type SourceRouteContext = { params: Promise<{ sourceId: string }> };

export async function PATCH(request: NextRequest, ctx: SourceRouteContext) {
  try {
    const user = await requireCompetitorIntelligenceSession();
    const { sourceId } = await ctx.params;
    const input = PatchSchema.parse(await request.json());
    const source = await updateCompetitorSourceStatus(sourceId, input.status, user.email);
    return NextResponse.json({ source });
  } catch (error) {
    return competitorIntelligenceErrorResponse(error, "Failed to update competitor source");
  }
}
