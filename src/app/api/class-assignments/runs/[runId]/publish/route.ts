import { NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  assertWiseClassroomWritebackAllowed,
  createClassroomPublishJob,
  runClassroomPublishJob,
} from "@/lib/classrooms/data";

export const maxDuration = 300;

function schedulePublishJob(jobId: string) {
  const task = async () => {
    try {
      await runClassroomPublishJob(getDb(), jobId);
    } catch (error) {
      console.error("Classroom publish job failed", error);
    }
  };

  try {
    after(task);
  } catch {
    void task();
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;
  try {
    assertWiseClassroomWritebackAllowed(session.user?.email ?? null);

    let confirmation: string | null = null;
    try {
      const body = await request.json() as { confirmation?: unknown };
      confirmation = typeof body.confirmation === "string" ? body.confirmation : null;
    } catch {
      confirmation = null;
    }

    const progress = await createClassroomPublishJob(getDb(), {
      runId,
      createdBy: session.user?.email ?? null,
      confirmation,
    });

    schedulePublishJob(progress.jobId);

    return NextResponse.json({ jobId: progress.jobId, progress }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start class assignment publish";
    const status = message.endsWith("not found")
      ? 404
      : message.includes("Wise classroom writeback") || message.includes("WISE_CLASSROOM_WRITEBACK_ALLOWED_EMAILS")
        ? 403
        : message.startsWith("Publish confirmation mismatch")
          ? 400
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
