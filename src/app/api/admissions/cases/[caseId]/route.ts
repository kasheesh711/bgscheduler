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
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  getCaseDetail,
  projectCaseDetailForStudent,
  updateCaseLifecycle,
  updateCaseProfile,
} from "@/lib/admissions/cases";
import { admissionsHttpUrlSchema } from "@/lib/admissions/shared/urls";

interface CaseRouteContext {
  params: Promise<{ caseId: string }>;
}

const ExternalLinksSchema = z
  .record(
    z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/),
    admissionsHttpUrlSchema,
  )
  .refine((value) => Object.keys(value).length <= 20, "At most 20 external links are allowed");

const UpdateCaseSchema = z
  .object({
    status: z
      .enum(["completed", "withdrawn", "archived"])
      .optional(),
    driveFolder: admissionsHttpUrlSchema.nullable().optional(),
    familyPortalOpen: z.boolean().optional(),
    student: z
      .object({
        fullName: z.string().trim().min(1).optional(),
        preferredName: z.string().trim().nullable().optional(),
        phone: z.string().trim().nullable().optional(),
        school: z.string().trim().nullable().optional(),
        schoolCounselor: z.string().trim().nullable().optional(),
        wiseStudentKey: z.string().trim().nullable().optional(),
        externalLinks: ExternalLinksSchema.optional(),
      })
      .optional(),
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.driveFolder !== undefined ||
      value.familyPortalOpen !== undefined ||
      value.student !== undefined,
    { message: "No updates provided" },
  )
  .refine(
    (value) =>
      value.status === undefined ||
      (value.driveFolder === undefined &&
        value.familyPortalOpen === undefined &&
        value.student === undefined),
    { message: "Lifecycle and profile updates must be submitted separately" },
  );

export async function GET(_request: NextRequest, context: CaseRouteContext) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await context.params;
    const access = await requireCaseAccess(user.email, caseId, "parent");

    if (access.role === "parent") {
      return NextResponse.json({ error: "Use parent dashboard" }, { status: 403 });
    }

    const detail = await getCaseDetail(caseId);
    return NextResponse.json({
      case: access.role === "student"
        ? projectCaseDetailForStudent(detail)
        : detail,
    });
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
    const access = await requireCaseAccess(user.email, caseId, "student");
    assertCaseMutationAllowed(access);

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
    if (
      access.role === "student" &&
      (parsed.data.status !== undefined ||
        parsed.data.driveFolder !== undefined ||
        parsed.data.familyPortalOpen !== undefined ||
        parsed.data.student?.wiseStudentKey !== undefined)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

    if (
      parsed.data.driveFolder !== undefined ||
      parsed.data.familyPortalOpen !== undefined ||
      parsed.data.student !== undefined
    ) {
      await updateCaseProfile({
        caseId,
        actor,
        expectedUpdatedAt: parsed.data.expectedUpdatedAt,
        driveFolder: parsed.data.driveFolder,
        ...(parsed.data.familyPortalOpen !== undefined
          ? { familyPortalOpen: parsed.data.familyPortalOpen }
          : {}),
        student: parsed.data.student,
      });
    }

    if (parsed.data.status !== undefined) {
      await updateCaseLifecycle(caseId, parsed.data.status, actor);
    }

    const detail = await getCaseDetail(caseId);
    return NextResponse.json({
      case: access.role === "student"
        ? projectCaseDetailForStudent(detail)
        : detail,
    });
  } catch (error) {
    return admissionsErrorResponse(
      "/api/admissions/cases/[caseId]",
      error,
      "Case update failed",
    );
  }
}
