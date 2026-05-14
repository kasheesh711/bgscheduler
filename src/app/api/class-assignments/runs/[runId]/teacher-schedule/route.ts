import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getTeacherScheduleForRun } from "@/lib/classrooms/data";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;
  try {
    const schedule = await getTeacherScheduleForRun(getDb(), runId);
    return NextResponse.json(schedule);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load teacher schedule";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
