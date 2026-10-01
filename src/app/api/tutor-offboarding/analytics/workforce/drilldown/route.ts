import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { parseWorkforceDrilldownQuery } from "@/lib/tutor-offboarding/workforce/query";
import { getWorkforceDrilldown } from "@/lib/tutor-offboarding/workforce/service";

export async function GET(request: Request) {
  let response: Response;
  try {
    await requireTutorOffboardingAdmin();
    const query = parseWorkforceDrilldownQuery(new URL(request.url).searchParams);
    response = NextResponse.json(await getWorkforceDrilldown(getDb(), query, new Date()));
  } catch (error) {
    response = tutorOffboardingErrorResponse("[workforce] detail failed", error, "Workforce detail could not load.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
