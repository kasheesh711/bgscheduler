import { NextResponse } from "next/server";
import { z } from "zod";

import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  COLLEGE_REQUIREMENT_KINDS,
  createCollegeRequirement,
  deleteCollegeRequirement,
  listCollegeRequirements,
  updateCollegeRequirement,
} from "@/lib/admissions/college-details";
import { admissionsHttpUrlSchema } from "@/lib/admissions/shared/urls";

const ROUTE = "/api/admissions/cases/[caseId]/colleges/[listItemId]/requirements";
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const requirementFields = {
  kind: z.enum(COLLEGE_REQUIREMENT_KINDS),
  title: z.string().trim().min(1).max(500),
  status: z.enum(["not_started", "in_progress", "done"]),
  owner: z.enum(["student", "counselor"]),
  dueDate: dateOnly.nullish(),
  required: z.boolean(),
  sourceUrl: admissionsHttpUrlSchema.nullish(),
  notes: z.string().max(10_000).nullish(),
  sortOrder: z.number().int().min(0).max(10_000),
};
const createSchema = z.object({
  kind: requirementFields.kind,
  title: requirementFields.title,
  status: requirementFields.status.optional(),
  owner: requirementFields.owner.optional(),
  dueDate: requirementFields.dueDate,
  required: requirementFields.required.optional(),
  sourceUrl: requirementFields.sourceUrl,
  notes: requirementFields.notes,
  sortOrder: requirementFields.sortOrder.optional(),
});
const updateSchema = z.object({
  requirementId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(),
  kind: requirementFields.kind.optional(),
  title: requirementFields.title.optional(),
  status: requirementFields.status.optional(),
  owner: requirementFields.owner.optional(),
  dueDate: requirementFields.dueDate,
  required: requirementFields.required.optional(),
  sourceUrl: requirementFields.sourceUrl,
  notes: requirementFields.notes,
  sortOrder: requirementFields.sortOrder.optional(),
  verify: z.boolean().optional(),
});
const deleteSchema = z.object({ requirementId: z.string().uuid() });
type Context = { params: Promise<{ caseId: string; itemId: string }> };

export async function GET(_request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");
    return NextResponse.json({ requirements: await listCollegeRequirements(caseId, itemId) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "College requirements load failed");
  }
}

export async function POST(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    return NextResponse.json({ requirement: await createCollegeRequirement({ access, listItemId: itemId, ...parsed.data }) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "College requirement create failed");
  }
}

export async function PATCH(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    assertCaseMutationAllowed(access);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    return NextResponse.json({ requirement: await updateCollegeRequirement({ access, listItemId: itemId, ...parsed.data }) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "College requirement update failed");
  }
}

export async function DELETE(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);
    const parsed = deleteSchema.safeParse({ requirementId: new URL(request.url).searchParams.get("requirementId") });
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    await deleteCollegeRequirement({ access, listItemId: itemId, requirementId: parsed.data.requirementId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "College requirement delete failed");
  }
}
