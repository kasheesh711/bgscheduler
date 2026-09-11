import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { resolveStudentScheduleLink } from "@/lib/student-schedule/links";
import { getStudentMonthlySchedule } from "@/lib/student-schedule/data";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getDb();
  const grant = await resolveStudentScheduleLink(db, token);
  if (!grant) return NextResponse.json({ error: "Schedule unavailable" }, { status: 404 });
  const payload = await getStudentMonthlySchedule(db, { studentKey: grant.studentKey, monthKey: grant.monthKey, forceRefresh: true, signal: request.signal });
  if (!payload) return NextResponse.json({ error: "Schedule unavailable" }, { status: 404 });
  return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
