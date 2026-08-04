import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getStudentMonthlySchedule } from "@/lib/student-schedule/data";
import {
  DEFAULT_LINK_TTL_DAYS,
  mintStudentScheduleLink,
  studentScheduleLinkUrl,
} from "@/lib/student-schedule/links";

const bodySchema = z.object({
  studentKey: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM"),
});

function baseUrl(request: NextRequest): string {
  return process.env.APP_BASE_URL?.trim() || request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    // Mint only for a student that actually resolves on the active snapshot,
    // so a token can never grant access to an arbitrary key.
    const schedule = await getStudentMonthlySchedule(db, {
      studentKey: parsed.data.studentKey,
      monthKey: parsed.data.month,
    });
    if (!schedule) {
      return NextResponse.json({ error: "Student not found" }, { status: 404 });
    }

    const ttlDays = Number(process.env.STUDENT_SCHEDULE_LINK_TTL_DAYS) || DEFAULT_LINK_TTL_DAYS;
    const { token, expiresAt } = await mintStudentScheduleLink(db, {
      studentKey: schedule.student.studentKey,
      wiseStudentId: schedule.student.wiseStudentId,
      studentName: schedule.student.studentName,
      monthKey: schedule.monthKey,
      createdByEmail: session.user.email,
      ttlDays,
    });

    return NextResponse.json({
      url: studentScheduleLinkUrl(baseUrl(request), token),
      expiresAt: expiresAt.toISOString(),
      sessionCount: schedule.sessions.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create link";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
