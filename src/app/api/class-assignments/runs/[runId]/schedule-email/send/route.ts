import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { sendScheduleEmailsForRun } from "@/lib/classrooms/schedule-email";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;
  try {
    const result = await sendScheduleEmailsForRun(
      getDb(),
      runId,
      session.user?.email ?? null,
    );
    const status = result.preview.ready ? 200 : 409;
    return NextResponse.json(result, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send schedule emails";
    const status = message === "Assignment run not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
