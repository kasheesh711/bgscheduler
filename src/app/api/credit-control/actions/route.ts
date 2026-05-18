import { NextResponse } from "next/server";
import { requireCreditControlSession, creditControlErrorResponse } from "@/lib/credit-control/api";
import { clearStudentAction, setStudentAction } from "@/lib/credit-control/actions";
import { normalizeStudentActionStatus } from "@/lib/credit-control/action-helpers";
import { getCreditControlPayload } from "@/lib/credit-control/service";

export async function POST(request: Request) {
  try {
    const sessionUser = await requireCreditControlSession();
    const body = (await request.json()) as { studentKey?: string; status?: string | null };
    const studentKey = String(body.studentKey ?? "").trim();

    if (!studentKey) {
      return NextResponse.json({ error: "studentKey is required" }, { status: 400 });
    }

    const payload = await getCreditControlPayload();
    const student = payload.students.find((item) => item.studentKey === studentKey);
    if (!student) {
      return NextResponse.json({ error: "Student not found" }, { status: 404 });
    }

    const normalizedStatus = normalizeStudentActionStatus(body.status);
    const actionState = normalizedStatus
      ? {
          status: normalizedStatus,
          updatedAt: new Date().toISOString(),
          updatedByName: sessionUser.name,
          isToday: true,
        }
      : null;

    if (normalizedStatus) {
      await setStudentAction({
        studentKey,
        studentName: student.student,
        parentName: student.parent,
        status: normalizedStatus,
        updatedByEmail: sessionUser.email,
        updatedByName: sessionUser.name,
      });
    } else {
      await clearStudentAction({
        studentKey,
        studentName: student.student,
        parentName: student.parent,
        actorEmail: sessionUser.email,
        actorName: sessionUser.name,
      });
    }

    return NextResponse.json({ ok: true, studentKey, actionState });
  } catch (error) {
    return creditControlErrorResponse("/api/credit-control/actions", error, "Action request failed");
  }
}
