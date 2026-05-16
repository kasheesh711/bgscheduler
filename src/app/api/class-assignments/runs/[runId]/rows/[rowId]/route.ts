import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { updateClassroomAssignmentOverride } from "@/lib/classrooms/data";

const overrideRequestSchema = z.object({
  overrideRoom: z.string().trim().nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = overrideRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { runId, rowId } = await params;
  try {
    const detail = await updateClassroomAssignmentOverride(getDb(), {
      runId,
      rowId,
      overrideRoom: parsed.data.overrideRoom?.trim() || null,
      updatedBy: session.user?.email ?? null,
    });
    return NextResponse.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update assignment override";
    const status = message.endsWith("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
