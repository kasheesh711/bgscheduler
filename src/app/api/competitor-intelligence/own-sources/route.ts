import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  competitorIntelligenceErrorResponse,
  requireCompetitorIntelligenceSession,
} from "@/lib/competitor-intelligence/access";
import { listOwnBrandSources, upsertOwnBrandSource } from "@/lib/competitor-intelligence/data";

const OwnSourceSchema = z.object({
  sourceType: z.enum(["website", "instagram", "facebook"]),
  label: z.string().trim().min(1).max(120),
  url: z.string().trim().url(),
  handle: z.string().trim().max(120).nullable().optional(),
  status: z.enum(["active", "disabled", "needs_review", "archived"]).optional(),
});

export async function GET() {
  try {
    await requireCompetitorIntelligenceSession();
    const sources = await listOwnBrandSources();
    return NextResponse.json({ sources });
  } catch (error) {
    return competitorIntelligenceErrorResponse(error, "Failed to list own-brand sources");
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireCompetitorIntelligenceSession();
    const input = OwnSourceSchema.parse(await request.json());
    const source = await upsertOwnBrandSource(input, user.email);
    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    return competitorIntelligenceErrorResponse(error, "Failed to save own-brand source");
  }
}
