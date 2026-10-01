import { NextResponse } from "next/server";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { loadTutorOffboardingAnalytics } from "@/lib/tutor-offboarding/analytics-service";

/** Read-only staff turnover and teaching-coverage analysis; no removal capability or Wise writes. */
export async function GET() {
  try {
    await requireTutorOffboardingAdmin();
    return NextResponse.json(await loadTutorOffboardingAnalytics());
  } catch (error) {
    return tutorOffboardingErrorResponse(
      "[tutor-offboarding] analytics failed",
      error,
      "Tutor Offboarding analytics could not load.",
    );
  }
}
