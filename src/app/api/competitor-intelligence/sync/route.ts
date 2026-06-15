import { NextResponse } from "next/server";
import {
  competitorIntelligenceErrorResponse,
  requireCompetitorIntelligenceSession,
} from "@/lib/competitor-intelligence/access";
import { runCompetitorIntelligenceSync } from "@/lib/competitor-intelligence/sync";

export const maxDuration = 800;

export async function POST() {
  try {
    const user = await requireCompetitorIntelligenceSession();
    const result = await runCompetitorIntelligenceSync({
      triggerType: "manual",
      actorEmail: user.email,
    });
    return NextResponse.json({ ok: result.status === "success", result }, {
      status: result.status === "success" ? 200 : 500,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("already running")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return competitorIntelligenceErrorResponse(error, "Failed to run competitor intelligence sync");
  }
}
