import { NextResponse } from "next/server";
import { requireCreditControlSession, creditControlErrorResponse } from "@/lib/credit-control/api";
import { clearInactiveStudent, markInactiveStudent } from "@/lib/credit-control/actions";
import { getCreditControlPayload } from "@/lib/credit-control/service";

export async function POST(request: Request) {
  try {
    const sessionUser = await requireCreditControlSession();
    const body = (await request.json()) as { studentKey?: string };
    const studentKey = String(body.studentKey ?? "").trim();

    if (!studentKey) {
      return NextResponse.json({ error: "studentKey is required" }, { status: 400 });
    }

    const payload = await getCreditControlPayload();
    const student = payload.students.find((item) => item.studentKey === studentKey);
    if (!student) {
      return NextResponse.json({ error: "Student not found" }, { status: 404 });
    }

    // Record the balance at removal so reactivation requires a genuine top-up
    // above this level (matches the auto-churn reactivation rule).
    const removedAtRemaining = student.packages.reduce((sum, pkg) => sum + pkg.currentRemaining, 0);
    await markInactiveStudent({
      studentKey,
      studentName: student.student,
      parentName: student.parent,
      markedByEmail: sessionUser.email,
      source: "manual",
      removedAtRemaining,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return creditControlErrorResponse("/api/credit-control/inactive", error, "Inactive request failed");
  }
}

export async function DELETE(request: Request) {
  try {
    await requireCreditControlSession();
    const body = (await request.json()) as { studentKey?: string };
    const studentKey = String(body.studentKey ?? "").trim();

    if (!studentKey) {
      return NextResponse.json({ error: "studentKey is required" }, { status: 400 });
    }

    await clearInactiveStudent(studentKey);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return creditControlErrorResponse("/api/credit-control/inactive", error, "Inactive request failed");
  }
}
