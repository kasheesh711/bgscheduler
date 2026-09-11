import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ClassroomPrintConflictError, loadClassroomPrintReport, printRunsSchema } from "@/lib/classrooms/print-report";

export const maxDuration = 180;
const headers = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const allowed = session.user.allowedPages;
  if (allowed && !allowed.includes("/class-assignments")) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  const ids = printRunsSchema.safeParse(request.nextUrl.searchParams.get("runIds")?.split(",") ?? []);
  if (!ids.success) return NextResponse.json({ error: "Choose one to seven distinct saved assignment runs." }, { status: 400, headers });
  try { return NextResponse.json(await loadClassroomPrintReport(getDb(), ids.data), { headers }); }
  catch (error) {
    const conflict = error instanceof ClassroomPrintConflictError;
    return NextResponse.json({ error: conflict ? error.message : "Student rosters could not be refreshed from Wise. Retry before printing." }, { status: conflict ? 409 : 503, headers });
  }
}
