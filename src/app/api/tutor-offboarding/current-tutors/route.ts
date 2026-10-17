import { NextResponse } from "next/server";
import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { currentTutorsCsv } from "@/lib/tutor-offboarding/current-tutors";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { loadCurrentTutorList } from "@/lib/tutor-offboarding/service";

/** Read-only list of tutors teaching now, for the email-current-tutors team skill; `?format=csv` downloads recipients. */
export async function GET(request: Request) {
  let response: Response;
  try {
    const viewer = await requireTutorOffboardingAdmin();
    const query = new URL(request.url).searchParams.toString();
    const csv = query === "format=csv";
    if (query && !csv) throw new TutorOffboardingError("The only supported query is ?format=csv.", 400);
    const list = await loadCurrentTutorList(viewer);
    if (!csv) {
      response = NextResponse.json(list);
    } else if (!list.available) {
      response = NextResponse.json({ error: `The tutor list is unavailable (${list.reason}).` }, { status: 503 });
    } else {
      response = new Response(currentTutorsCsv(list), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="current-tutors-${bangkokDateKey(new Date(list.generatedAt))}.csv"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  } catch (error) {
    response = tutorOffboardingErrorResponse("[tutor-offboarding] current tutors failed", error, "The current tutor list could not load.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
