import { NextRequest, NextResponse } from "next/server";
import { runClassroomMorningAutomation } from "@/lib/classrooms/morning-automation";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;

  try {
    const result = await runClassroomMorningAutomation();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Classroom morning automation failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
