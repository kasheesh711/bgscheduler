import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  admissionsAwardGradeLevelsSchema,
  admissionsAwardRecognitionLevelsSchema,
  createAward,
  listAwardsForCase,
  MAX_COMMON_APP_RANKED_AWARDS,
  setCommonAppAwardRanks,
  softDeleteAward,
  UC_AWARD_ACHIEVEMENT_MAX_CHARS,
  UC_AWARD_ELIGIBILITY_MAX_CHARS,
  updateAward,
} from "@/lib/admissions/awards";
import { roleAtLeast } from "@/lib/admissions/config";

const ROUTE = "/api/admissions/cases/[caseId]/awards";
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const awardFields = {
  title: z.string().trim().min(1),
  organization: z.string().nullish(),
  gradeLevels: admissionsAwardGradeLevelsSchema.optional(),
  recognitionLevels: admissionsAwardRecognitionLevelsSchema.optional(),
  awardDate: dateOnlySchema.nullish(),
  commonAppRank: z.number().int().min(1).max(MAX_COMMON_APP_RANKED_AWARDS).nullish(),
  ucEligibilityNarrative: z.string().max(UC_AWARD_ELIGIBILITY_MAX_CHARS).nullish(),
  ucAchievementNarrative: z.string().max(UC_AWARD_ACHIEVEMENT_MAX_CHARS).nullish(),
  internalNotes: z.string().nullish(),
};
const createSchema = z.object(awardFields);
const updateSchema = z.object({
  action: z.literal("update"),
  awardId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(),
  title: awardFields.title.optional(),
  organization: awardFields.organization,
  gradeLevels: awardFields.gradeLevels,
  recognitionLevels: awardFields.recognitionLevels,
  awardDate: awardFields.awardDate,
  commonAppRank: awardFields.commonAppRank,
  ucEligibilityNarrative: awardFields.ucEligibilityNarrative,
  ucAchievementNarrative: awardFields.ucAchievementNarrative,
  internalNotes: awardFields.internalNotes,
});
const rankSchema = z.object({
  action: z.literal("rank"),
  orderedIds: z.array(z.string().uuid()).max(MAX_COMMON_APP_RANKED_AWARDS)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Duplicate award ids" }),
});
const patchSchema = z.discriminatedUnion("action", [updateSchema, rankSchema]);
const deleteSchema = z.object({ awardId: z.string().uuid() });
type Context = { params: Promise<{ caseId: string }> };

export async function GET(_request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    const awards = await listAwardsForCase(caseId, {
      includeInternalNotes: roleAtLeast(access.role, "counselor"),
    });
    return NextResponse.json({ awards });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Awards load failed");
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
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }
    if (parsed.data.internalNotes !== undefined && !roleAtLeast(access.role, "counselor")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ award: await createAward({ access, ...parsed.data }) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Award create failed");
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
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }
    if (parsed.data.action === "rank") {
      await setCommonAppAwardRanks({ access, orderedIds: parsed.data.orderedIds });
      return NextResponse.json({ ok: true });
    }
    if (parsed.data.internalNotes !== undefined && !roleAtLeast(access.role, "counselor")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({
      award: await updateAward({
        access,
        awardId: parsed.data.awardId,
        expectedUpdatedAt: parsed.data.expectedUpdatedAt,
        title: parsed.data.title,
        organization: parsed.data.organization,
        gradeLevels: parsed.data.gradeLevels,
        recognitionLevels: parsed.data.recognitionLevels,
        awardDate: parsed.data.awardDate,
        commonAppRank: parsed.data.commonAppRank,
        ucEligibilityNarrative: parsed.data.ucEligibilityNarrative,
        ucAchievementNarrative: parsed.data.ucAchievementNarrative,
        internalNotes: parsed.data.internalNotes,
      }),
    });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Award update failed");
  }
}

export async function DELETE(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    assertCaseMutationAllowed(access);
    const parsed = deleteSchema.safeParse({
      awardId: new URL(request.url).searchParams.get("awardId"),
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    }
    await softDeleteAward({ access, awardId: parsed.data.awardId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Award delete failed");
  }
}
