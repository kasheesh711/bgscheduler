// Admissions Case Management — activities routes (design §4, PRD
// CM-70..CM-72).
//
// Students OWN the activities master list (design §2.4 self-report surface),
// so every method runs at minRole student; counselor/admin writes pass
// through and are attributed via the audit actorRole, never disguised.
// Parents are view-only via the parent dashboard projection and get 403
// here. GET lists the live rows ranked-first. POST adds a row (the CM-70
// live-row cap → 409 from the lib). PATCH is an action union: "update"
// partially edits one activity (hard Zod char limits on the platform blocks,
// optional expectedUpdatedAt optimistic concurrency → 409 on a stale token);
// "rank" persists the CM-71 Common App top-10 order via setCommonAppRanks
// (≤10 unique live activity ids). DELETE soft-deletes by ?activityId=
// (students may delete their own list rows). requireCaseAccess runs BEFORE
// body parsing on every method (design §4).

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  admissionsCommonAppBlockSchema,
  admissionsUcBlockSchema,
  createActivity,
  listActivitiesForCase,
  MAX_COMMON_APP_RANKED_ACTIVITIES,
  setCommonAppRanks,
  softDeleteActivity,
  updateActivity,
} from "@/lib/admissions/activities";

const ROUTE = "/api/admissions/cases/[caseId]/activities";

// The platform blocks reuse the lib's exported hard-limit schemas
// (admissionsCommonAppBlockSchema / admissionsUcBlockSchema) so char-limit
// overflow is a 400 here — the lib re-validates fail-closed.
const createActivitySchema = z.object({
  name: z.string().trim().min(1, "Activity requires a non-empty name"),
  fullDescription: z.string().nullish(),
  commonApp: admissionsCommonAppBlockSchema.nullish(),
  uc: admissionsUcBlockSchema.nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

// Omitted fields are left untouched; explicit nulls clear nullable fields.
// commonAppRank is deliberately absent — ranks change only via the "rank"
// action (CM-71).
const updateActionSchema = z.object({
  action: z.literal("update"),
  activityId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(),
  name: z.string().trim().min(1, "Activity requires a non-empty name").optional(),
  fullDescription: z.string().nullish(),
  commonApp: admissionsCommonAppBlockSchema.nullish(),
  uc: admissionsUcBlockSchema.nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

// The full ranked selection, best first; the lib assigns ranks 1..n and
// clears the ranks of unlisted activities. Mirrors the setCommonAppRanks
// up-front validation (≤10, unique, uuid-shaped) as a 400 boundary.
const rankActionSchema = z.object({
  action: z.literal("rank"),
  orderedIds: z
    .array(z.string().uuid())
    .max(
      MAX_COMMON_APP_RANKED_ACTIVITIES,
      `Common App rank list accepts at most ${MAX_COMMON_APP_RANKED_ACTIVITIES} activities`,
    )
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Duplicate activity ids in the Common App rank list",
    }),
});

const patchActivitySchema = z.discriminatedUnion("action", [
  updateActionSchema,
  rankActionSchema,
]);

const deleteQuerySchema = z.object({ activityId: z.string().uuid() });

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");

    const activities = await listActivitiesForCase(caseId);
    return NextResponse.json({ activities });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Activity list failed");
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

    const parsed = createActivitySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const activity = await createActivity({
      access,
      name: parsed.data.name,
      fullDescription: parsed.data.fullDescription,
      commonApp: parsed.data.commonApp,
      uc: parsed.data.uc,
      sortOrder: parsed.data.sortOrder,
    });
    return NextResponse.json({ activity });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Activity add failed");
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

    const parsed = patchActivitySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    if (parsed.data.action === "rank") {
      await setCommonAppRanks({ access, orderedIds: parsed.data.orderedIds });
      return NextResponse.json({ ok: true });
    }

    const activity = await updateActivity({
      access,
      activityId: parsed.data.activityId,
      expectedUpdatedAt: parsed.data.expectedUpdatedAt,
      name: parsed.data.name,
      fullDescription: parsed.data.fullDescription,
      commonApp: parsed.data.commonApp,
      uc: parsed.data.uc,
      sortOrder: parsed.data.sortOrder,
    });
    return NextResponse.json({ activity });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Activity update failed");
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
      activityId: new URL(request.url).searchParams.get("activityId"),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    await softDeleteActivity({ access, activityId: parsed.data.activityId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Activity delete failed");
  }
}
