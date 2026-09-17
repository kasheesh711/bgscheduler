import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClassroomOperationsOwner, classroomOperationsAccessError } from "@/lib/classrooms/operations-access";
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
  try { actor = await requireClassroomOperationsOwner(); }
  catch (error) { return classroomOperationsAccessError(error); }

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
