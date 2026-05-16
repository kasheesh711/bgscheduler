import { NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  createClassroomPublishJob,
  isWiseClassroomWritebackEnabled,
  runClassroomPublishJob,
  wiseClassroomWritebackDisabledMessage,
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
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isWiseClassroomWritebackEnabled()) {
    return NextResponse.json({ error: wiseClassroomWritebackDisabledMessage() }, { status: 403 });
  }

  const { runId } = await params;
  try {
    const progress = await createClassroomPublishJob(getDb(), {
      runId,
      createdBy: session.user?.email ?? null,
    });

    schedulePublishJob(progress.jobId);

    return NextResponse.json({ jobId: progress.jobId, progress }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start class assignment publish";
    const status = message.endsWith("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
