import { streamJsonResponse } from "@/lib/tutor-offboarding/workforce/response";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { parseWorkforceQuery } from "@/lib/tutor-offboarding/workforce/query";
import { getWorkforceReport } from "@/lib/tutor-offboarding/workforce/service";
import { WORKFORCE_REFRESH_HEADER } from "@/lib/tutor-offboarding/workforce/read-cache";

export const maxDuration = 120;

export async function GET(request: Request) {
  let response: Response;
  try {
    await requireTutorOffboardingAdmin();
    const query = parseWorkforceQuery(new URL(request.url).searchParams);
    response = streamJsonResponse(await getWorkforceReport(getDb(), query, new Date(), undefined, request.headers.get(WORKFORCE_REFRESH_HEADER) === "1"));
  } catch (error) {
    response = tutorOffboardingErrorResponse("[workforce] report failed", error, "Workforce analytics could not load.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
