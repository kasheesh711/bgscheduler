import { NextResponse } from "next/server";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { loadTutorOffboardingDashboard } from "@/lib/tutor-offboarding/service";

/** Read-only dashboard payload: scores, exclusions, staff accounts, decisions and (owner only) removal grants. */
export async function GET() {
  try {
    const viewer = await requireTutorOffboardingAdmin();
    return NextResponse.json(await loadTutorOffboardingDashboard(viewer));
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] dashboard failed", error, "The tutor offboarding dashboard could not load.");
  }
}
