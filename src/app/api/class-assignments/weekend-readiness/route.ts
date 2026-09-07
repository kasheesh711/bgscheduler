import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { loadWeekendCheck } from "@/lib/classrooms/weekend-check";
import { weekendDates } from "@/lib/classrooms/weekend-config";

export async function GET(request: NextRequest) {
  if (!await auth()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const query = z.object({ checkId: z.uuid().optional() }).safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "Invalid check ID" }, { status: 400 });
  try {
    const check = await loadWeekendCheck(getDb(), query.data);
    if (!check && query.data.checkId) return NextResponse.json({ error: "Weekend report not found" }, { status: 404 });
    return NextResponse.json({ check, dates: weekendDates(new Date()) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to load weekend readiness. Classroom coverage has not been verified." }, { status: 500 });
  }
}
