import { NextResponse } from "next/server";
import {
  competitorIntelligenceErrorResponse,
  requireCompetitorIntelligenceSession,
} from "@/lib/competitor-intelligence/access";
import { acceptCompetitorTaskSuggestion } from "@/lib/competitor-intelligence/data";

type SuggestionRouteContext = { params: Promise<{ suggestionId: string }> };

export async function POST(_request: Request, ctx: SuggestionRouteContext) {
  try {
    const user = await requireCompetitorIntelligenceSession();
    const { suggestionId } = await ctx.params;
    const task = await acceptCompetitorTaskSuggestion(suggestionId, user.email);
    return NextResponse.json({ task });
  } catch (error) {
    return competitorIntelligenceErrorResponse(error, "Failed to accept task suggestion");
  }
}
