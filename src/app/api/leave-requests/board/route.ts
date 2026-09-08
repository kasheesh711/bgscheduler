import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { assertLeaveAdmin, getLeaveBoard } from "@/lib/leave-requests/work-data";
import { validDate } from "@/lib/leave-requests/work-model";
import { todayBangkok } from "@/lib/room-capacity/dates";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  try { await assertLeaveAdmin(db, session.user.email); } catch { return NextResponse.json({ error: "Leave Requests access is required." }, { status: 403 }); }
  const date = request.nextUrl.searchParams.get("date") || todayBangkok();
  const view = request.nextUrl.searchParams.get("view") || "daily";
  if (!validDate(date) || !["daily", "upcoming", "history"].includes(view)) return NextResponse.json({ error: "Choose a valid date and view." }, { status: 400 });
  const payload = await getLeaveBoard(db, { email: session.user.email.toLowerCase(), date, view: view as "daily" | "upcoming" | "history", q: request.nextUrl.searchParams.get("q")?.slice(0, 200) });
  return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
