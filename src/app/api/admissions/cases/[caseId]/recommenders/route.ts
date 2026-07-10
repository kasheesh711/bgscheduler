// Admissions Case Management — recommender routes (design §4, PRD
// CM-46/CM-50/CM-51).
//
// GET lists a case's live recommenders (with per-college submission links)
// plus its college-doc rows (minRole student — parents get 403). POST creates
// a recommender (counselor+). PATCH multiplexes recommender mutations via
// body.action: "update" (fields + the forward-only askStatus machine — an
// illegal move is 409 via the lib), "link" (recommender ↔ college, duplicate
// → 409), "submission" (per-college pending/submitted, CM-51), and
// "college_doc" (transcript / school report / per-sitting score send, CM-46)
// — all counselor+. DELETE soft-deletes a recommender by ?recommenderId=
// (counselor+). requireCaseAccess runs BEFORE body parsing on every method
// (design §4).
//
// Cross-case scoping (fail-closed): the lib's link/submission/doc functions
// derive the case from the recommender/list-item row, so this route pins the
// body's ids to the URL's caseId first — a foreign recommenderId/listItemId
// reads as 404, never a write into another case.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import { listCollegesForCase } from "@/lib/admissions/colleges";
import {
  createRecommender,
  linkRecommenderToCollege,
  listCollegeDocs,
  listRecommenders,
  setCollegeDoc,
  setRecommenderSubmission,
  softDeleteRecommender,
  updateRecommender,
} from "@/lib/admissions/recommenders";
import type { AdmissionsActor } from "@/lib/admissions/members";
import type { CaseAccess } from "@/lib/admissions/types";

const ROUTE = "/api/admissions/cases/[caseId]/recommenders";

// Mirrors ADMISSIONS_RECOMMENDER_ASK_STATUSES (src/lib/admissions/
// recommenders.ts); the lib re-validates fail-closed, this just gives a 400
// instead of a 500.
const askStatusSchema = z.enum(["planned", "asked", "agreed", "declined"]);

// Mirrors ADMISSIONS_COLLEGE_DOC_TYPES (src/lib/admissions/recommenders.ts).
const docTypeSchema = z.enum(["transcript", "school_report", "score_send"]);

const createRecommenderSchema = z.object({
  name: z.string().trim().min(1, "Recommender name must not be empty"),
  roleSubject: z.string().nullish(),
  contact: z.string().nullish(),
});

const patchRecommenderSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"),
    recommenderId: z.string().uuid(),
    name: z.string().trim().min(1, "Recommender name must not be empty").optional(),
    roleSubject: z.string().nullish(),
    contact: z.string().nullish(),
    askStatus: askStatusSchema.optional(),
  }),
  z.object({
    action: z.literal("link"),
    recommenderId: z.string().uuid(),
    listItemId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("submission"),
    recommenderId: z.string().uuid(),
    listItemId: z.string().uuid(),
    submitted: z.boolean(),
  }),
  z.object({
    action: z.literal("college_doc"),
    listItemId: z.string().uuid(),
    docType: docTypeSchema,
    sent: z.boolean(),
    testSittingId: z.string().uuid().nullish(),
  }),
]);

const deleteQuerySchema = z.object({ recommenderId: z.string().uuid() });

/** Actor attributed on audit rows, derived from the resolved case access. */
function toActor(access: CaseAccess): AdmissionsActor {
  return { email: access.email, role: access.role };
}

/**
 * Pins a body-supplied recommenderId to the URL's case (fail-closed): the
 * lib's link/submission functions derive the case FROM the recommender row,
 * so a foreign id must read as "NotFound" here, never act on another case.
 */
async function assertRecommenderInCase(caseId: string, recommenderId: string): Promise<void> {
  const recommenders = await listRecommenders(caseId);
  if (!recommenders.some((rec) => rec.id === recommenderId)) throw new Error("NotFound");
}

/**
 * Pins a body-supplied listItemId to the URL's case (fail-closed): the lib's
 * setCollegeDoc derives the case FROM the list-item row, so a foreign id must
 * read as "NotFound" here, never write a doc row into another case.
 */
async function assertListItemInCase(caseId: string, listItemId: string): Promise<void> {
  const items = await listCollegesForCase(caseId);
  if (!items.some((item) => item.id === listItemId)) throw new Error("NotFound");
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");

    const recommenders = await listRecommenders(caseId);
    const collegeDocs = await listCollegeDocs(caseId);
    return NextResponse.json({ recommenders, collegeDocs });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Recommender list failed");
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

    const parsed = createRecommenderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const recommender = await createRecommender(
      caseId,
      {
        name: parsed.data.name,
        roleSubject: parsed.data.roleSubject,
        contact: parsed.data.contact,
      },
      toActor(access),
    );
    return NextResponse.json({ recommender });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Recommender create failed");
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

    const parsed = patchRecommenderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    switch (parsed.data.action) {
      case "update": {
        const recommender = await updateRecommender(
          caseId,
          parsed.data.recommenderId,
          {
            name: parsed.data.name,
            roleSubject: parsed.data.roleSubject,
            contact: parsed.data.contact,
            askStatus: parsed.data.askStatus,
          },
          toActor(access),
        );
        return NextResponse.json({ recommender });
      }
      case "link": {
        await assertRecommenderInCase(caseId, parsed.data.recommenderId);
        const link = await linkRecommenderToCollege(
          parsed.data.recommenderId,
          parsed.data.listItemId,
          toActor(access),
        );
        return NextResponse.json({ link });
      }
      case "submission": {
        await assertRecommenderInCase(caseId, parsed.data.recommenderId);
        const link = await setRecommenderSubmission(
          parsed.data.recommenderId,
          parsed.data.listItemId,
          parsed.data.submitted,
          toActor(access),
        );
        return NextResponse.json({ link });
      }
      case "college_doc": {
        // CM-46 pairing rule at the 400 boundary (the lib re-validates):
        // "score_send" requires the sitting whose scores were sent; the
        // other doc types forbid one.
        const testSittingId = parsed.data.testSittingId ?? null;
        const isScoreSend = parsed.data.docType === "score_send";
        if (isScoreSend ? testSittingId === null : testSittingId !== null) {
          return NextResponse.json(
            {
              error: isScoreSend
                ? 'docType "score_send" requires a testSittingId'
                : `testSittingId is only valid for score_send (got docType "${parsed.data.docType}")`,
            },
            { status: 400 },
          );
        }
        await assertListItemInCase(caseId, parsed.data.listItemId);
        const doc = await setCollegeDoc(
          parsed.data.listItemId,
          parsed.data.docType,
          { sent: parsed.data.sent, testSittingId },
          toActor(access),
        );
        return NextResponse.json({ doc });
      }
    }
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Recommender update failed");
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
      recommenderId: new URL(request.url).searchParams.get("recommenderId"),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    await softDeleteRecommender(caseId, parsed.data.recommenderId, toActor(access));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Recommender delete failed");
  }
}
