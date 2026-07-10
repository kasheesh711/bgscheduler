import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  academicRecordPayloadSchema,
  createAcademicRecord,
  getLegacyAcademicWorksheetForCase,
  listAcademicRecordsForCase,
  softDeleteAcademicRecord,
  updateAcademicRecord,
} from "@/lib/admissions/academics";

const ROUTE = "/api/admissions/cases/[caseId]/academics";
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createSchema = z.object({
  payload: academicRecordPayloadSchema,
  effectiveDate: dateOnlySchema,
});

const updateSchema = z.object({
  recordId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(),
  payload: academicRecordPayloadSchema.optional(),
  effectiveDate: dateOnlySchema.optional(),
}).refine((value) => value.payload !== undefined || value.effectiveDate !== undefined, {
  message: "No updates provided",
});

const deleteSchema = z.object({ recordId: z.string().uuid() });
type Context = { params: Promise<{ caseId: string }> };

export async function GET(_request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");
    const [records, legacyImport] = await Promise.all([
      listAcademicRecordsForCase(caseId),
      getLegacyAcademicWorksheetForCase(caseId),
    ]);
    return NextResponse.json({ records, legacyImport });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Academic records load failed");
  }
}

export async function POST(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }
    const record = await createAcademicRecord({ access, ...parsed.data });
    return NextResponse.json({ record });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Academic record create failed");
  }
}

export async function PATCH(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }
    const record = await updateAcademicRecord({ access, ...parsed.data });
    return NextResponse.json({ record });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Academic record update failed");
  }
}

export async function DELETE(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);
    const parsed = deleteSchema.safeParse({
      recordId: new URL(request.url).searchParams.get("recordId"),
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }
    await softDeleteAcademicRecord({ access, recordId: parsed.data.recordId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Academic record delete failed");
  }
}
