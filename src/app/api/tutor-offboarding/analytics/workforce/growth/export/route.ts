import { streamTextResponse } from "@/lib/tutor-offboarding/workforce/response";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { parseGrowthExportRequest, readGrowthBody } from "@/lib/tutor-offboarding/workforce/growth/query";
import { getGrowthReport } from "@/lib/tutor-offboarding/workforce/growth/service";
import { serializeGrowthCsv } from "@/lib/tutor-offboarding/workforce/growth/csv";

export const maxDuration = 120;

export async function POST(request: Request) {
  let response: Response;
  try {
    await requireTutorOffboardingAdmin();
    const { query, section, reportRevision } = parseGrowthExportRequest(await readGrowthBody(request));
    const report = await getGrowthReport(getDb(), query, new Date(), reportRevision);
    if (report.reportRevision !== reportRevision) throw new TutorOffboardingError("The report changed. Refresh before exporting.", 409);
    response = streamTextResponse(`\uFEFF${serializeGrowthCsv(report, section)}`, { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="course-demand-${section}-${query.filters.from}-${query.filters.to}.csv"`,
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    response = tutorOffboardingErrorResponse("[growth] export failed", error, "Course demand export could not load.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
