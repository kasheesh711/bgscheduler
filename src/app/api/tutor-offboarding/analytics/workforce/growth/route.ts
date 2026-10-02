import { streamJsonResponse } from "@/lib/tutor-offboarding/workforce/response";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { parseGrowthGetQuery, parseGrowthRequest, readGrowthBody } from "@/lib/tutor-offboarding/workforce/growth/query";
import { getGrowthReport } from "@/lib/tutor-offboarding/workforce/growth/service";
import { WORKFORCE_REFRESH_HEADER } from "@/lib/tutor-offboarding/workforce/read-cache";

export const maxDuration = 120;

async function report(request: Request, scenario: boolean) {
  let response: Response;
  try {
    await requireTutorOffboardingAdmin();
    const query = scenario ? parseGrowthRequest(await readGrowthBody(request)) : parseGrowthGetQuery(new URL(request.url).searchParams);
    response = streamJsonResponse(await getGrowthReport(getDb(), query, new Date(), undefined, request.headers.get(WORKFORCE_REFRESH_HEADER) === "1"));
  } catch (error) {
    response = tutorOffboardingErrorResponse("[growth] report failed", error, "Course demand could not load.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export async function GET(request: Request) { return report(request, false); }
/** Read-only scenario calculation; assumptions are never saved. */
export async function POST(request: Request) { return report(request, true); }
