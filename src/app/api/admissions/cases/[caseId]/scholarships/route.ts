import { NextResponse } from "next/server";
import { z } from "zod";

import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  createScholarship,
  deleteScholarship,
  listScholarships,
  SCHOLARSHIP_STATUSES,
  updateScholarship,
} from "@/lib/admissions/college-details";
import { admissionsHttpUrlSchema } from "@/lib/admissions/shared/urls";

const ROUTE = "/api/admissions/cases/[caseId]/scholarships";
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
const scholarshipFields = {
  listItemId: z.string().uuid().nullish(),
  name: z.string().trim().min(1).max(500),
  provider: z.string().max(500).nullish(),
  url: admissionsHttpUrlSchema.nullish(),
  requirements: z.string().max(20_000).nullish(),
  deadline: dateOnly.nullish(),
  status: z.enum(SCHOLARSHIP_STATUSES),
  outcome: z.string().max(500).nullish(),
  offeredAmount: amount.nullish(),
  notes: z.string().max(20_000).nullish(),
};
const createSchema = z.object({
  listItemId: scholarshipFields.listItemId,
  name: scholarshipFields.name,
  provider: scholarshipFields.provider,
  url: scholarshipFields.url,
  requirements: scholarshipFields.requirements,
  deadline: scholarshipFields.deadline,
  status: scholarshipFields.status.optional(),
  outcome: scholarshipFields.outcome,
  offeredAmount: scholarshipFields.offeredAmount,
  notes: scholarshipFields.notes,
});
const updateSchema = z.object({
  scholarshipId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(),
  listItemId: scholarshipFields.listItemId,
  name: scholarshipFields.name.optional(),
  provider: scholarshipFields.provider,
  url: scholarshipFields.url,
  requirements: scholarshipFields.requirements,
  deadline: scholarshipFields.deadline,
  status: scholarshipFields.status.optional(),
  outcome: scholarshipFields.outcome,
  offeredAmount: scholarshipFields.offeredAmount,
  notes: scholarshipFields.notes,
});
const deleteSchema = z.object({ scholarshipId: z.string().uuid() });
type Context = { params: Promise<{ caseId: string }> };

export async function GET(_request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");
    return NextResponse.json({ scholarships: await listScholarships(caseId) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Scholarships load failed");
  }
}

export async function POST(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    assertCaseMutationAllowed(access);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    return NextResponse.json({ scholarship: await createScholarship({ access, ...parsed.data }) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Scholarship create failed");
  }
}

export async function PATCH(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    assertCaseMutationAllowed(access);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    return NextResponse.json({ scholarship: await updateScholarship({ access, ...parsed.data }) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Scholarship update failed");
  }
}

export async function DELETE(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    assertCaseMutationAllowed(access);
    const parsed = deleteSchema.safeParse({ scholarshipId: new URL(request.url).searchParams.get("scholarshipId") });
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    await deleteScholarship({ access, scholarshipId: parsed.data.scholarshipId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Scholarship delete failed");
  }
}
