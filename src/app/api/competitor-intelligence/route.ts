import { NextResponse } from "next/server";
import {
  competitorIntelligenceErrorResponse,
  requireCompetitorIntelligenceSession,
} from "@/lib/competitor-intelligence/access";
import { getCompetitorIntelligencePayload } from "@/lib/competitor-intelligence/data";

export async function GET() {
  try {
    await requireCompetitorIntelligenceSession();
    const payload = await getCompetitorIntelligencePayload();
    return NextResponse.json(payload);
  } catch (error) {
    return competitorIntelligenceErrorResponse(error, "Failed to load competitor intelligence");
  }
}
