// ----------------------------------------------------------------------------
// Parent class report — authenticated API read route.
// Loads snapshot-scoped report data through the student-report data layer.
// ----------------------------------------------------------------------------

import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getParentClassReport } from "@/lib/student-report/db";
import { normalizeReportParams, reportParamsSchema } from "@/lib/student-report/params";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = reportParamsSchema.safeParse(
    normalizeReportParams({
      student: request.nextUrl.searchParams.getAll("student"),
      from: request.nextUrl.searchParams.get("from") ?? undefined,
      to: request.nextUrl.searchParams.get("to") ?? undefined,
    }),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await getParentClassReport(getDb(), {
      studentKeys: parsed.data.students,
      from: parsed.data.from,
      to: parsed.data.to,
    });

    if (result.status === "no-snapshot") {
      return NextResponse.json(
        { error: "No active credit-control snapshot" },
        { status: 503 },
      );
    }
    if (result.status === "students-not-found") {
      return NextResponse.json(
        {
          error: "Some students were not found on the active snapshot",
          missing: result.missing,
        },
        { status: 404 },
      );
    }

    return NextResponse.json(result.payload);
  } catch (err) {
    console.error("student-report GET failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build report" },
      { status: 500 },
    );
  }
}
