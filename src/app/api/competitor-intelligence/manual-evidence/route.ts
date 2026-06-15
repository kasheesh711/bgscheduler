import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  competitorIntelligenceErrorResponse,
  requireCompetitorIntelligenceSession,
} from "@/lib/competitor-intelligence/access";
import { createManualCompetitorEvidence } from "@/lib/competitor-intelligence/data";

const ManualEvidenceSchema = z.object({
  entityId: z.string().uuid(),
  title: z.string().trim().min(2).max(180),
  contentText: z.string().trim().min(2).max(5000),
  canonicalUrl: z.string().url().nullable().optional(),
  pricingSignal: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireCompetitorIntelligenceSession();
    const input = ManualEvidenceSchema.parse(await request.json());
    const evidence = await createManualCompetitorEvidence(input, user.email);
    return NextResponse.json({ evidence });
  } catch (error) {
    return competitorIntelligenceErrorResponse(error, "Failed to create manual competitor evidence");
  }
}
