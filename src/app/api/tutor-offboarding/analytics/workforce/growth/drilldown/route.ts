import { streamJsonResponse } from "@/lib/tutor-offboarding/workforce/response";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { parseGrowthDetailRequest, readGrowthBody } from "@/lib/tutor-offboarding/workforce/growth/query";
import { getGrowthDrilldown } from "@/lib/tutor-offboarding/workforce/growth/service";

export const maxDuration = 120;

export async function POST(request: Request) {
  let response: Response;
  try {
    await requireTutorOffboardingAdmin();
    const query = parseGrowthDetailRequest(await readGrowthBody(request));
    response = streamJsonResponse(await getGrowthDrilldown(getDb(), query, new Date()));
  } catch (error) {
    response = tutorOffboardingErrorResponse("[growth] detail failed", error, "Course demand details could not load.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
