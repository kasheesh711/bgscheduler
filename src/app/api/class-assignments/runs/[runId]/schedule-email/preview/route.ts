import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getScheduleEmailPreview } from "@/lib/classrooms/schedule-email";

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
    const preview = await getScheduleEmailPreview(getDb(), runId);
    return NextResponse.json(preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build schedule email preview";
    const status = message === "Assignment run not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
