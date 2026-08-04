import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getStudentMonthlySchedule } from "@/lib/student-schedule/data";

const querySchema = z.object({
  studentKey: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM"),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = querySchema.safeParse({
    studentKey: request.nextUrl.searchParams.get("studentKey") ?? undefined,
    month: request.nextUrl.searchParams.get("month") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const payload = await getStudentMonthlySchedule(getDb(), {
      studentKey: parsed.data.studentKey,
      monthKey: parsed.data.month,
    });
    if (!payload) {
      return NextResponse.json({ error: "Student not found" }, { status: 404 });
    }
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load schedule";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
