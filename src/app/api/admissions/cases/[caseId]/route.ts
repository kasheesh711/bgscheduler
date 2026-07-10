// Admissions Case Management — case detail + updates (lifecycle/profile).
//
// Design: docs/casemanagementsystem_design.md §4 (`/cases/[caseId]`).
// requireCaseAccess runs before body parsing on every request (design §2.2 —
// revocation is instant, cross-case tampering 403s). GET is role-shaped:
// parents are redirected to their projection surface (design §2.3 — the full
// detail DTO is a staff/student view; leaks are structural). PATCH is
// counselor-minimum and accepts expectedUpdatedAt for optimistic concurrency
// (design §6 — mismatch returns 409 with both versions).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  getCaseDetail,
  updateCaseLifecycle,
  updateCaseProfile,
} from "@/lib/admissions/cases";

interface CaseRouteContext {
  params: Promise<{ caseId: string }>;
}

const UpdateCaseSchema = z
  .object({
    status: z
      .enum(["active", "committed", "completed", "withdrawn", "archived"])
      .optional(),
    driveFolder: z.string().trim().nullable().optional(),
    student: z
      .object({
        fullName: z.string().trim().min(1).optional(),
        preferredName: z.string().trim().nullable().optional(),
        phone: z.string().trim().nullable().optional(),
        school: z.string().trim().nullable().optional(),
        schoolCounselor: z.string().trim().nullable().optional(),
        wiseStudentKey: z.string().trim().nullable().optional(),
      })
      .optional(),
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.driveFolder !== undefined ||
      value.student !== undefined,
    { message: "No updates provided" },
  );

export async function GET(_request: NextRequest, context: CaseRouteContext) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await context.params;
    const access = await requireCaseAccess(user.email, caseId, "parent");

    if (access.role === "parent") {
      return NextResponse.json({ error: "Use parent dashboard" }, { status: 403 });
    }

    return NextResponse.json({ case: await getCaseDetail(caseId) });
  } catch (error) {
    return admissionsErrorResponse(
      "/api/admissions/cases/[caseId]",
      error,
      "Case load failed",
    );
  }
}

export async function PATCH(request: NextRequest, context: CaseRouteContext) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await context.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = UpdateCaseSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const current = await getCaseDetail(caseId);
    if (
      parsed.data.expectedUpdatedAt !== undefined &&
      parsed.data.expectedUpdatedAt !== current.updatedAt
    ) {
      return NextResponse.json(
        {
          error: "Conflict",
          expectedUpdatedAt: parsed.data.expectedUpdatedAt,
          currentUpdatedAt: current.updatedAt,
        },
        { status: 409 },
      );
    }

    const actor = { email: access.email, role: access.role };

    // Profile fields first (updateCaseProfile re-checks the token inside its
    // transaction), then the lifecycle transition.
    if (parsed.data.driveFolder !== undefined || parsed.data.student !== undefined) {
      await updateCaseProfile({
        caseId,
        actor,
        expectedUpdatedAt: parsed.data.expectedUpdatedAt,
        driveFolder: parsed.data.driveFolder,
        student: parsed.data.student,
      });
    }

    if (parsed.data.status !== undefined) {
      await updateCaseLifecycle(caseId, parsed.data.status, actor);
    }

    return NextResponse.json({ case: await getCaseDetail(caseId) });
  } catch (error) {
    return admissionsErrorResponse(
      "/api/admissions/cases/[caseId]",
      error,
      "Case update failed",
    );
  }
}
