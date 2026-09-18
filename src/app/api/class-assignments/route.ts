import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { requireClassroomOperationsOwner, classroomOperationsAccessError } from "@/lib/classrooms/operations-access";
import { checkOverflowSolver } from "@/lib/classrooms/overflow-planner";
import {
  assertIsoDate,
  getClassroomAssignmentForDate,
} from "@/lib/classrooms/data";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.nextUrl.searchParams.get("optimizerCheck") === "1") {
    try { await requireClassroomOperationsOwner(); }
    catch (error) { return classroomOperationsAccessError(error); }
    try { return NextResponse.json(await checkOverflowSolver(), { headers: { "Cache-Control": "no-store" } }); }
    catch (error) {
      console.error("Overflow optimizer runtime check failed", error);
      return NextResponse.json({ ok: false, error: "Optimizer runtime unavailable" }, { status: 503 });
    }
  }

  const date = request.nextUrl.searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "date is required" }, { status: 400 });
  }

  try {
    const detail = await getClassroomAssignmentForDate(getDb(), assertIsoDate(date));
    return NextResponse.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load class assignments";
    const status = message.startsWith("Invalid date") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
