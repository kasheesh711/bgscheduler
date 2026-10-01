import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { parseWorkforceQuery } from "@/lib/tutor-offboarding/workforce/query";
import { getWorkforceReport } from "@/lib/tutor-offboarding/workforce/service";

export async function GET(request: Request) {
  let response: Response;
  try {
    await requireTutorOffboardingAdmin();
    const query = parseWorkforceQuery(new URL(request.url).searchParams);
    response = NextResponse.json(await getWorkforceReport(getDb(), query, new Date()));
  } catch (error) {
    response = tutorOffboardingErrorResponse("[workforce] report failed", error, "Workforce analytics could not load.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
