import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { runClassroomAssignment } from "@/lib/classrooms/data";

const runRequestSchema = z.object({
  date: z.string(),
  forceReassign: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
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
      createdBy: session.user?.email ?? null,
    });
    return NextResponse.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run class assignments";
    const status = message.startsWith("Invalid date") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
