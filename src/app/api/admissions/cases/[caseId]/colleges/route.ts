// Admissions Case Management — college list routes (design §4, PRD
// CM-40..CM-42/44/46).
//
// GET lists a case's live college rows — list item + live IPEDS stats +
// stale flag + the CM-46 completeness rollup — at minRole student (parents
// are view-only via the parent dashboard projection and get 403 here). POST
// adds a college (counselor+) with the CM-40 unitId-vs-manual entry union;
// a duplicate row on the case → 409 from the lib. PATCH partially updates
// plan fields (round/deadline/appStatus/category/aid) with optional
// expectedUpdatedAt optimistic concurrency (counselor+; stale token → 409).
// DELETE soft-deletes by ?itemId= (counselor+; the lib clears the case's
// committed pointer in the same transaction when it referenced the item).
// requireCaseAccess runs BEFORE body parsing on every method (design §4).

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  addCollegeListItem,
  listCollegesForCase,
  softDeleteCollegeListItem,
  updateCollegeListItem,
  type AddCollegeEntry,
} from "@/lib/admissions/colleges";
import { computeCollegeCompleteness } from "@/lib/admissions/recommenders";

const ROUTE = "/api/admissions/cases/[caseId]/colleges";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected "YYYY-MM-DD"');

// Mirrors ADMISSIONS_APP_ROUNDS (src/lib/admissions/colleges.ts); the lib
// re-validates fail-closed, this just gives a 400 instead of a 500.
const appRoundSchema = z.enum([
  "ed",
  "ed2",
  "ea",
  "rea",
  "rd",
  "rolling",
  "priority",
  "other",
]);

// Mirrors ADMISSIONS_APP_STATUSES (src/lib/admissions/colleges.ts).
const appStatusSchema = z.enum(["researching", "applying", "submitted", "complete"]);

// Mirrors ADMISSIONS_COLLEGE_CATEGORIES (src/lib/admissions/colleges.ts).
const collegeCategorySchema = z.enum(["reach", "match", "safety", "unset"]);

const addCollegePlanShape = {
  round: appRoundSchema,
  deadline: dateOnlySchema.nullish(),
  category: collegeCategorySchema.optional(),
};

// CM-40 entry union: an IPEDS unitId (US institutions) or a manual free-text
// row (non-US / unlisted). Neither shape matching → 400; when both keys are
// sent the unitId branch wins (strip mode drops the extra manual payload).
const addCollegeSchema = z.union([
  z.object({
    unitId: z.coerce.number().int().positive(),
    ...addCollegePlanShape,
  }),
  z.object({
    manual: z.object({
      instName: z.string().trim().min(1, "Manual entry requires a non-empty instName"),
      country: z.string().trim().min(1, "Manual entry requires a non-empty country"),
    }),
    ...addCollegePlanShape,
  }),
]);

// Mirrors AID_AMOUNT_PATTERN (src/lib/admissions/colleges.ts).
const aidAmountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "Expected a non-negative decimal amount");

// Omitted fields are left untouched; explicit nulls clear nullable fields.
// An update with no plan fields is a lib-level no-op that echoes the item.
const updateCollegeSchema = z.object({
  itemId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(),
  round: appRoundSchema.optional(),
  deadline: dateOnlySchema.nullish(),
  appStatus: appStatusSchema.optional(),
  category: collegeCategorySchema.optional(),
  aidOffered: aidAmountSchema.nullish(),
  aidNotes: z.string().nullish(),
});

const deleteQuerySchema = z.object({ itemId: z.string().uuid() });

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");

    // CM-46: the recommenders module supplies the per-item completeness
    // rollup; listCollegesForCase carries it on each row via the hook.
    const completenessMap = await computeCollegeCompleteness(caseId);
    const colleges = await listCollegesForCase(caseId, { completenessMap });
    return NextResponse.json({ colleges });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "College list failed");
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = addCollegeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const entry: AddCollegeEntry =
      "unitId" in parsed.data
        ? { unitId: parsed.data.unitId }
        : { manual: parsed.data.manual };
    const college = await addCollegeListItem({
      access,
      entry,
      round: parsed.data.round,
      deadline: parsed.data.deadline,
      category: parsed.data.category,
    });
    return NextResponse.json({ college });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "College add failed");
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = updateCollegeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const college = await updateCollegeListItem({
      access,
      itemId: parsed.data.itemId,
      expectedUpdatedAt: parsed.data.expectedUpdatedAt,
      round: parsed.data.round,
      deadline: parsed.data.deadline,
      appStatus: parsed.data.appStatus,
      category: parsed.data.category,
      aidOffered: parsed.data.aidOffered,
      aidNotes: parsed.data.aidNotes,
    });
    return NextResponse.json({ college });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "College update failed");
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

    const parsed = deleteQuerySchema.safeParse({
      itemId: new URL(request.url).searchParams.get("itemId"),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    await softDeleteCollegeListItem({ access, itemId: parsed.data.itemId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "College delete failed");
  }
}
