import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  competitorIntelligenceErrorResponse,
  requireCompetitorIntelligenceSession,
} from "@/lib/competitor-intelligence/access";
import { disableOwnBrandSource, upsertOwnBrandSource } from "@/lib/competitor-intelligence/data";

const PatchOwnSourceSchema = z.object({
  sourceType: z.enum(["website", "instagram", "facebook"]),
  label: z.string().trim().min(1).max(120),
  url: z.string().trim().url(),
  handle: z.string().trim().max(120).nullable().optional(),
  status: z.enum(["active", "disabled", "needs_review", "archived"]).optional(),
});

type OwnSourceRouteContext = { params: Promise<{ sourceId: string }> };

export async function PATCH(request: NextRequest, ctx: OwnSourceRouteContext) {
  try {
    const user = await requireCompetitorIntelligenceSession();
    const { sourceId } = await ctx.params;
    const input = PatchOwnSourceSchema.parse(await request.json());
    const source = input.status === "disabled"
      ? await disableOwnBrandSource(sourceId, user.email)
      : await upsertOwnBrandSource({ ...input, id: sourceId }, user.email);
    return NextResponse.json({ source });
  } catch (error) {
    return competitorIntelligenceErrorResponse(error, "Failed to update own-brand source");
  }
}
