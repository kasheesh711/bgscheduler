import { NextResponse } from "next/server";
import { requireCreditControlSession, creditControlErrorResponse } from "@/lib/credit-control/api";
import { bulkClearAction, bulkSetAction } from "@/lib/credit-control/actions";
import { normalizeStudentActionStatus } from "@/lib/credit-control/action-helpers";
import { getCreditControlPayload } from "@/lib/credit-control/service";

export async function POST(request: Request) {
  try {
    const sessionUser = await requireCreditControlSession();
    const body = (await request.json()) as { studentKeys?: string[]; status?: string | null };
    const studentKeys = Array.from(
      new Set((body.studentKeys ?? []).map((item) => String(item ?? "").trim()).filter(Boolean)),
    );

    if (studentKeys.length === 0) {
      return NextResponse.json({ error: "studentKeys is required" }, { status: 400 });
    }

    const wantsClear = body.status === null || body.status === "";
    const normalizedStatus = wantsClear ? null : normalizeStudentActionStatus(body.status);
    if (!wantsClear && !normalizedStatus) {
      return NextResponse.json({ error: "valid status is required" }, { status: 400 });
    }

    const payload = await getCreditControlPayload();
    const updates = studentKeys
      .map((studentKey) => payload.students.find((item) => item.studentKey === studentKey))
      .filter((student): student is NonNullable<typeof student> => Boolean(student))
      .map((student) => ({
        studentKey: student.studentKey,
        studentName: student.student,
        parentName: student.parent,
      }));

    if (updates.length === 0) {
      return NextResponse.json({ updated: [] });
    }

    if (normalizedStatus) {
      await bulkSetAction({
        updates: updates.map((update) => ({ ...update, status: normalizedStatus })),
        actorEmail: sessionUser.email,
        actorName: sessionUser.name,
      });
    } else {
      await bulkClearAction({
        updates,
        actorEmail: sessionUser.email,
        actorName: sessionUser.name,
      });
    }

    const updatedAt = new Date().toISOString();
    return NextResponse.json({
      updated: updates.map((update) => ({
        studentKey: update.studentKey,
        actionState: normalizedStatus
          ? {
              status: normalizedStatus,
              updatedAt,
              updatedByName: sessionUser.name,
              isToday: true,
            }
          : null,
      })),
    });
  } catch (error) {
    return creditControlErrorResponse("/api/credit-control/actions/bulk", error, "Bulk action request failed");
  }
}
