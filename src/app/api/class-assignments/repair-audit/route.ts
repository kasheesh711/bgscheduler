import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getPlainTvLocationRepairAudit } from "@/lib/classrooms/data";

const CSV_COLUMNS = [
  "publishJobId",
  "publishJobStatus",
  "publishedBy",
  "runId",
  "assignmentDate",
  "rowId",
  "wiseClassId",
  "wiseSessionId",
  "studentName",
  "tutorDisplayName",
  "startTimeBangkok",
  "wrongLocation",
  "intendedLocation",
  "publishedAt",
] as const;

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rows = await getPlainTvLocationRepairAudit(getDb());
    if (request.nextUrl.searchParams.get("format") === "csv") {
      const header = CSV_COLUMNS.join(",");
      const body = rows.map((row) => CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","));
      return new NextResponse([header, ...body].join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=plain-tv-location-repair-audit.csv",
        },
      });
    }

    return NextResponse.json({ rows, count: rows.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate repair audit";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
