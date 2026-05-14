import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getClassroomPublishJobProgress } from "@/lib/classrooms/data";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string; jobId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId, jobId } = await params;
  try {
    const result = await getClassroomPublishJobProgress(getDb(), runId, jobId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load publish progress";
    const status = message.endsWith("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
