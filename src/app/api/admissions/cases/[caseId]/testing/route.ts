// Admissions Case Management — testing tab routes (design §2.4/§4, PRD
// CM-80..CM-83).
//
// GET lists a case's test sittings + best scores; POST adds a sitting; PATCH
// partially updates one; DELETE removes one. Every method runs at minRole
// student — testing self-entries are the student's self-report surface
// (design §2.4), so parents get 403 on all methods. scoreReleasedToParent is
// COUNSELOR-ONLY (CM-83): enforced per-field HERE (a student providing the
// flag → 403 before any lib call) and again fail-closed inside updateSitting.
// requireCaseAccess runs BEFORE body parsing on every method (design §4).

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import { roleAtLeast } from "@/lib/admissions/config";
import {
  createSitting,
  getBestScores,
  listSittingsForCase,
  softDeleteSitting,
  updateSitting,
} from "@/lib/admissions/testing";

const ROUTE = "/api/admissions/cases/[caseId]/testing";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected "YYYY-MM-DD"');

// Mirrors ADMISSIONS_TEST_TYPES (src/lib/admissions/testing.ts); the lib
// re-validates types fail-closed, this just gives a 400 instead of a 500.
const testTypeSchema = z.enum(["sat", "act", "ap", "ib", "toefl", "ielts", "other"]);

const createSittingSchema = z.object({
  testType: testTypeSchema,
  testDate: dateOnlySchema,
  targetScore: z.string().optional(),
  accommodations: z.string().nullish(),
});

const updateSittingSchema = z.object({
  sittingId: z.string().uuid(),
  expectedUpdatedAt: z.string().optional(),
  testType: testTypeSchema.optional(),
  testDate: dateOnlySchema.optional(),
  registrationDeadline: dateOnlySchema.nullish(),
  targetScore: z.string().optional(),
  actualScore: z.string().nullish(),
  accommodations: z.string().nullish(),
  scoreReleasedToParent: z.boolean().optional(),
});

const deleteQuerySchema = z.object({ sittingId: z.string().uuid() });

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");

    const [sittings, bestScores] = await Promise.all([
      listSittingsForCase(caseId),
      getBestScores(caseId),
    ]);
    return NextResponse.json({ sittings, bestScores });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Testing list failed");
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = createSittingSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const sitting = await createSitting({
      access,
      testType: parsed.data.testType,
      testDate: parsed.data.testDate,
      targetScore: parsed.data.targetScore,
      accommodations: parsed.data.accommodations ?? null,
    });
    return NextResponse.json({ sitting });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Sitting create failed");
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = updateSittingSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // Per-field gate (CM-83): scoreReleasedToParent is counselor+ only —
    // reject a student (or parent) attempt before any lib call. The lib
    // re-enforces this fail-closed.
    if (
      parsed.data.scoreReleasedToParent !== undefined &&
      !roleAtLeast(access.role, "counselor")
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const sitting = await updateSitting({
      access,
      sittingId: parsed.data.sittingId,
      expectedUpdatedAt: parsed.data.expectedUpdatedAt,
      testType: parsed.data.testType,
      testDate: parsed.data.testDate,
      registrationDeadline: parsed.data.registrationDeadline,
      targetScore: parsed.data.targetScore,
      actualScore: parsed.data.actualScore,
      accommodations: parsed.data.accommodations,
      scoreReleasedToParent: parsed.data.scoreReleasedToParent,
    });
    return NextResponse.json({ sitting });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Sitting update failed");
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");

    const parsed = deleteQuerySchema.safeParse({
      sittingId: new URL(request.url).searchParams.get("sittingId"),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    await softDeleteSitting({ access, sittingId: parsed.data.sittingId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Sitting delete failed");
  }
}
