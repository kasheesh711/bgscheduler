// Admissions Case Management — essay tracker routes (design §4, PRD
// CM-60..CM-63).
//
// GET lists a case's live essay rows — staleness + effective stage, most
// urgent first — at minRole student (parents are view-only via the parent
// dashboard projection and get 403 here). POST adds a row at minRole student:
// essays are a self-report surface (design §2.4), so students may add;
// counselor/admin creations pass through and are attributed via the audit
// actorRole. PATCH partially updates a row with the §2.4 per-field write
// split — prompt/status/driveUrl are student-writable, while
// counselorStage/deadline/listItemId require counselor+ (a student providing
// one → 403 here before the lib is touched; the lib re-checks fail-closed) —
// with optional expectedUpdatedAt optimistic concurrency (stale token → 409).
// DELETE soft-deletes by ?essayId= (counselor+ — deleting tracker rows is
// staff work, not self-report). requireCaseAccess runs BEFORE body parsing
// on every method (design §4).

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import { roleAtLeast } from "@/lib/admissions/config";
import {
  createEssay,
  listEssaysForCase,
  softDeleteEssay,
  updateEssay,
} from "@/lib/admissions/essays";
import { admissionsHttpUrlSchema } from "@/lib/admissions/shared/urls";

const ROUTE = "/api/admissions/cases/[caseId]/essays";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected "YYYY-MM-DD"');

// Mirrors ADMISSIONS_ESSAY_STATUSES (src/lib/admissions/essays.ts); the lib
// re-validates fail-closed, this just gives a 400 instead of a 500.
const essayStatusSchema = z.enum([
  "not_started",
  "brainstorming",
  "drafting",
  "feedback",
  "final",
]);

const createEssaySchema = z.object({
  prompt: z.string().trim().min(1, "Essay requires a non-empty prompt"),
  listItemId: z.string().uuid().nullish(),
  deadline: dateOnlySchema.nullish(),
  driveUrl: admissionsHttpUrlSchema.nullish(),
  sharedWithFamily: z.boolean().optional(),
});

// Omitted fields are left untouched; explicit nulls clear nullable fields.
// counselorStage / deadline / listItemId are the counselor+ fields — the
// handler enforces the §2.4 per-field split after parsing.
const updateEssaySchema = z.object({
  essayId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(),
  prompt: z.string().trim().min(1, "Essay requires a non-empty prompt").optional(),
  status: essayStatusSchema.optional(),
  driveUrl: admissionsHttpUrlSchema.nullish(),
  counselorStage: essayStatusSchema.nullish(),
  deadline: dateOnlySchema.nullish(),
  listItemId: z.string().uuid().nullish(),
  sharedWithFamily: z.boolean().optional(),
});

const deleteQuerySchema = z.object({ essayId: z.string().uuid() });

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");

    const essays = await listEssaysForCase(caseId);
    return NextResponse.json({ essays });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Essay list failed");
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
    assertCaseMutationAllowed(access);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = createEssaySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    if (
      !roleAtLeast(access.role, "counselor") &&
      (parsed.data.sharedWithFamily !== undefined ||
        parsed.data.deadline !== undefined ||
        parsed.data.listItemId !== undefined)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const essay = await createEssay({
      access,
      prompt: parsed.data.prompt,
      listItemId: parsed.data.listItemId,
      deadline: parsed.data.deadline,
      driveUrl: parsed.data.driveUrl,
      sharedWithFamily: parsed.data.sharedWithFamily,
    });
    return NextResponse.json({ essay });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Essay add failed");
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
    assertCaseMutationAllowed(access);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = updateEssaySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // §2.4 per-field write split: counselorStage / deadline / listItemId are
    // counselor+ only — a student (or parent) providing one is refused here
    // before the lib is touched (the lib re-checks fail-closed).
    const wantsStaffFields =
      parsed.data.counselorStage !== undefined ||
      parsed.data.deadline !== undefined ||
      parsed.data.listItemId !== undefined ||
      parsed.data.sharedWithFamily !== undefined;
    if (wantsStaffFields && !roleAtLeast(access.role, "counselor")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const essay = await updateEssay({
      access,
      essayId: parsed.data.essayId,
      expectedUpdatedAt: parsed.data.expectedUpdatedAt,
      prompt: parsed.data.prompt,
      status: parsed.data.status,
      driveUrl: parsed.data.driveUrl,
      counselorStage: parsed.data.counselorStage,
      deadline: parsed.data.deadline,
      listItemId: parsed.data.listItemId,
      sharedWithFamily: parsed.data.sharedWithFamily,
    });
    return NextResponse.json({ essay });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Essay update failed");
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);

    const parsed = deleteQuerySchema.safeParse({
      essayId: new URL(request.url).searchParams.get("essayId"),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    await softDeleteEssay({ access, essayId: parsed.data.essayId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Essay delete failed");
  }
}
