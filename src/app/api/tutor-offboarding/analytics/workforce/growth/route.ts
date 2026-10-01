import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { parseGrowthGetQuery, parseGrowthRequest, readGrowthBody } from "@/lib/tutor-offboarding/workforce/growth/query";
import { getGrowthReport } from "@/lib/tutor-offboarding/workforce/growth/service";

async function report(request: Request, scenario: boolean) {
  let response: Response;
  try {
    await requireTutorOffboardingAdmin();
    const query = scenario ? parseGrowthRequest(await readGrowthBody(request)) : parseGrowthGetQuery(new URL(request.url).searchParams);
    response = NextResponse.json(await getGrowthReport(getDb(), query, new Date()));
  } catch (error) {
    response = tutorOffboardingErrorResponse("[growth] report failed", error, "Course demand could not load.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export async function GET(request: Request) { return report(request, false); }
/** Read-only scenario calculation; assumptions are never saved. */
export async function POST(request: Request) { return report(request, true); }
