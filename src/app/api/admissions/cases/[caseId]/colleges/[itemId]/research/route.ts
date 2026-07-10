import { NextResponse } from "next/server";
import { z } from "zod";

import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  getCollegeResearch,
  upsertCollegeResearch,
} from "@/lib/admissions/college-details";
import { admissionsHttpUrlSchema } from "@/lib/admissions/shared/urls";

const ROUTE = "/api/admissions/cases/[caseId]/colleges/[listItemId]/research";
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const payloadSchema = z.object({
  expectedUpdatedAt: z.string().datetime().optional(),
  fitRating: z.number().int().min(1).max(5).nullish(),
  sources: z.array(z.strictObject({
    label: z.string().trim().min(1),
    url: admissionsHttpUrlSchema.optional(),
  })).max(50).optional(),
  campusVisitDate: dateOnly.nullish(),
  campusVisitNotes: z.string().max(20_000).nullish(),
  academicNotes: z.string().max(20_000).nullish(),
  opportunities: z.string().max(20_000).nullish(),
  questions: z.string().max(20_000).nullish(),
  notes: z.string().max(20_000).nullish(),
});
type Context = { params: Promise<{ caseId: string; itemId: string }> };

export async function GET(_request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");
    return NextResponse.json({ research: await getCollegeResearch(caseId, itemId) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "College research load failed");
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
    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }
    return NextResponse.json({
      research: await upsertCollegeResearch({ access, listItemId: itemId, ...parsed.data }),
    });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "College research update failed");
  }
}
