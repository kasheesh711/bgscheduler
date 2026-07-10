import { NextResponse } from "next/server";
import { z } from "zod";

import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  getFinancialAidOffer,
  upsertFinancialAidOffer,
} from "@/lib/admissions/college-details";

const ROUTE = "/api/admissions/cases/[caseId]/colleges/[listItemId]/financial-aid";
const nullableAmount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/).nullish();
const breakdown = z.record(z.string().trim().min(1), z.number().nonnegative().nullable());
const payloadSchema = z.object({
  expectedUpdatedAt: z.string().datetime().optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  awardYear: z.number().int().min(2000).max(2200).optional(),
  costBreakdown: breakdown.optional(),
  giftAidBreakdown: breakdown.optional(),
  loanBreakdown: breakdown.optional(),
  workStudyAmount: nullableAmount,
  netCost: nullableAmount,
  remainingBalance: nullableAmount,
  notes: z.string().max(20_000).nullish(),
});
type Context = { params: Promise<{ caseId: string; itemId: string }> };

export async function GET(_request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");
    return NextResponse.json({ offer: await getFinancialAidOffer(caseId, itemId) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Financial aid load failed");
  }
}

export async function PUT(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    return NextResponse.json({ offer: await upsertFinancialAidOffer({ access, listItemId: itemId, ...parsed.data }) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Financial aid update failed");
  }
}
