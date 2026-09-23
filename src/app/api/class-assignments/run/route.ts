import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClassroomAdmin, classroomOperationsAccessError } from "@/lib/classrooms/operations-access";
import { isClassroomOperationsOwner, wiseClassroomAutomationEnabled } from "@/lib/classrooms/operations-policy";
import { getDb } from "@/lib/db";
import {
  runClassroomAssignment,
  StaleClassroomAssignmentSnapshotError,
} from "@/lib/classrooms/data";

export const maxDuration = 300;

const runRequestSchema = z.object({
  date: z.string(),
  forceReassign: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  let actor;
  try { actor = await requireClassroomAdmin(); }
  catch (error) { return classroomOperationsAccessError(error); }

  // runClassroomAssignment does a live Wise day read; while automation is
  // paused, only Kevin may trigger that, same as sync-wise and publish.
  if (!wiseClassroomAutomationEnabled() && !isClassroomOperationsOwner(actor.email)) {
    return NextResponse.json(
      { error: "Automation is paused — only Kevin can run assignments while paused." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = runRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (parsed.data.forceReassign && !isClassroomOperationsOwner(actor.email)) {
    return NextResponse.json({ error: "Only Kevin can force reassign." }, { status: 403 });
  }

  try {
    const detail = await runClassroomAssignment(getDb(), {
      date: parsed.data.date,
      forceReassign: parsed.data.forceReassign,
      createdBy: actor.email,
    });
    return NextResponse.json(detail);
  } catch (error) {
    if (error instanceof StaleClassroomAssignmentSnapshotError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          latestSyncFinishedAt: error.latestSyncFinishedAt,
          staleAgeMs: error.staleAgeMs,
        },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to run class assignments";
    const status = message.startsWith("Invalid date") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
