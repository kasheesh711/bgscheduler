import { NextResponse } from "next/server";
import { requireProgressTestsSession, progressTestsErrorResponse } from "@/lib/progress-tests/api";
import { getProgressTestsPayload } from "@/lib/progress-tests/service";
import { resolveTeacherCanonicalKeys } from "@/lib/progress-tests/teacher-access";

export async function GET() {
  try {
    const user = await requireProgressTestsSession();
    // Teachers see only their own students; resolve their canonicalKey set fresh
    // (covers online + onsite identities). Admins (null) see every enrollment.
    const teacherCanonicalKeys =
      user.role === "teacher" ? await resolveTeacherCanonicalKeys(user.email) : null;
    const payload = await getProgressTestsPayload({ teacherCanonicalKeys });
    return NextResponse.json(payload);
  } catch (error) {
    return progressTestsErrorResponse("/api/progress-tests", error, "Progress tests load failed");
  }
}
