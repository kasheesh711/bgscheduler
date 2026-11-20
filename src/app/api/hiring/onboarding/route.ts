import { after, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireHiringHr } from "@/lib/hiring/access";
import { deliverExpertsAlerts, expertsCaseProfile, expertsHrAction, updateExperts } from "@/lib/hiring/experts";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { HiringError, runtimeWritesAllowed } from "@/lib/hiring/model";
import { onboardingHrAction, updateOnboarding } from "@/lib/hiring/onboarding";

export const maxDuration = 180;

export async function GET(request: Request) {
  try {
    await requireHiringHr();
    const id = z.uuid().parse(new URL(request.url).searchParams.get("case"));
    return NextResponse.json(await expertsCaseProfile(getDb(), id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return hiringError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireHiringHr();
    requireSameOrigin(request);
    const db = getDb();
    const input: unknown = await request.json();
    const forExperts = typeof input === "object" && input !== null && "area" in input && input.area === "experts";
    if (forExperts) {
      if (process.env.VERCEL_ENV === "preview" || process.env.PREVIEW_SANDBOX_ENABLED === "true") {
        throw new HiringError(503, "Experts changes are unavailable in preview.");
      }
      await updateExperts(db, expertsHrAction.parse(input), actor);
      after(async () => { await deliverExpertsAlerts(db); });
    } else {
      if (!runtimeWritesAllowed()) throw new HiringError(503, "Hiring changes are temporarily unavailable.");
      await updateOnboarding(db, onboardingHrAction.parse(input), actor);
    }
    return NextResponse.json({ saved: true });
  } catch (error) {
    return hiringError(error);
  }
}
