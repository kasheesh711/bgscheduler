// Admissions Case Management — caseload query + case creation.
//
// Design: docs/casemanagementsystem_design.md §4 (`/cases` GET/POST, min role
// counselor). The caseload is a staff surface: students and parents are
// members of specific cases, never caseload viewers, so both roles 403 here
// (fail-closed). Staff rights are re-resolved from Postgres on EVERY request
// via requireCounselorOrAdmin (design §2.2 — the JWT role claim shapes nav
// only), so deactivating a counselor or removing an admin revokes this
// surface instantly, not at JWT expiry. Per-user scoping (admin = all cases,
// counselor = own active memberships) lives in getCaseloadForUser.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCounselorOrAdmin,
} from "@/lib/admissions/access";
import { createCase, getCaseloadForUser } from "@/lib/admissions/cases";

const CreateCaseSchema = z
  .object({
    student: z.object({
      fullName: z.string().trim().min(1),
      preferredName: z.string().trim().nullable().optional(),
      studentEmail: z.string().trim().email(),
      phone: z.string().trim().nullable().optional(),
      school: z.string().trim().nullable().optional(),
      schoolCounselor: z.string().trim().nullable().optional(),
      wiseStudentKey: z.string().trim().nullable().optional(),
    }),
    cohortId: z.string().uuid(),
    parentEmails: z.array(z.string().trim().email()).max(20).default([]),
    counselorEmails: z.array(z.string().trim().email()).min(1).max(20),
  })
  .superRefine((value, ctx) => {
    // PRD write-time rule: the same email cannot be both student and parent
    // on one case. createCase re-checks (Conflict) as the backstop.
    const studentEmail = value.student.studentEmail.toLowerCase();
    if (value.parentEmails.some((email) => email.toLowerCase() === studentEmail)) {
      ctx.addIssue({
        code: "custom",
        path: ["parentEmails"],
        message: "A parent email cannot equal the student email",
      });
    }
  });

export async function GET() {
  try {
    const user = await requireAdmissionsSession();
    await requireCounselorOrAdmin(user.email);

    const cases = await getCaseloadForUser(user.email);
    return NextResponse.json({ cases });
  } catch (error) {
    return admissionsErrorResponse(
      "/api/admissions/cases",
      error,
      "Caseload load failed",
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAdmissionsSession();
    // Postgres-resolved staff check (design §2.2): createCase performs no
    // actor re-validation, so this guard is the only gate on case creation.
    const staff = await requireCounselorOrAdmin(user.email);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = CreateCaseSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const result = await createCase({
      student: {
        fullName: parsed.data.student.fullName,
        preferredName: parsed.data.student.preferredName ?? null,
        studentEmail: parsed.data.student.studentEmail,
        phone: parsed.data.student.phone ?? null,
        school: parsed.data.student.school ?? null,
        schoolCounselor: parsed.data.student.schoolCounselor ?? null,
        wiseStudentKey: parsed.data.student.wiseStudentKey ?? null,
      },
      cohortId: parsed.data.cohortId,
      parentEmails: parsed.data.parentEmails,
      counselorEmails: parsed.data.counselorEmails,
      createdBy: { email: staff.email, role: staff.role },
    });

    return NextResponse.json(result);
  } catch (error) {
    return admissionsErrorResponse(
      "/api/admissions/cases",
      error,
      "Case creation failed",
    );
  }
}
