import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { parseWorkforceExportQuery } from "@/lib/tutor-offboarding/workforce/query";
import { getWorkforceReport } from "@/lib/tutor-offboarding/workforce/service";
import { serializeWorkforceCsv } from "@/lib/tutor-offboarding/workforce/csv";

export async function GET(request: Request) {
  let response: Response;
  try {
    await requireTutorOffboardingAdmin();
    const { query, section, reportRevision } = parseWorkforceExportQuery(new URL(request.url).searchParams);
    const report = await getWorkforceReport(getDb(), query, new Date());
    if (report.reportRevision !== reportRevision) throw new TutorOffboardingError("The report changed. Refresh before exporting.", 409);
    response = new Response(`\uFEFF${serializeWorkforceCsv(report, section)}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="workforce-${section}-${query.from}-${query.to}.csv"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    response = tutorOffboardingErrorResponse("[workforce] export failed", error, "Workforce export could not load.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
