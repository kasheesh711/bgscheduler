import { NextResponse } from "next/server";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { reconcileRemovalRuns } from "@/lib/tutor-offboarding/reconcile";
import { requireRemovalOperator } from "../removal-auth";

export const maxDuration = 120;

/** Read-only in Wise: uses the current roster to settle pending/manual outcomes. */
export async function POST() {
  try {
    const { db } = await requireRemovalOperator();
    const result = await reconcileRemovalRuns(db);
    return NextResponse.json({ result });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] removal reconcile failed", error, "Removal outcomes could not be reconciled.");
  }
}
