// Admissions Case Management — guided self-report section routes (design
// §2.4/§4/§5.2, PRD CM-121).
//
// GET reads one section's definition + saved answers + review state; PUT
// autosaves a PARTIAL payload into the draft (merge semantics live in
// saveSectionDraft); POST multiplexes the state machine via body.action
// (Zod discriminated union): "submit" (draft → submitted, the only notify
// event) runs at the student bar, "review" (submitted → reviewed) is
// counselor+ — enforced per-action HERE (a student attempt → 403 before any
// lib call) and again fail-closed inside reviewSection. All methods run
// requireCaseAccess at minRole student BEFORE body parsing (design §4 — the
// self-report surface is the student's, parents get 403). An unknown
// sectionKey is 404 only AFTER the membership check passes, so section keys
// never leak to non-members.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import { roleAtLeast } from "@/lib/admissions/config";
import {
  getSectionDefinition,
  getSectionState,
  reviewSection,
  saveSectionDraft,
  submitSection,
} from "@/lib/admissions/sections";

const ROUTE = "/api/admissions/cases/[caseId]/sections/[sectionKey]";

const saveDraftSchema = z.object({
  // PARTIAL payload — per-field type/option/maxLength rules live in the lib
  // (validateSectionPayload, fail-closed against the section definition).
  payload: z.record(z.string(), z.unknown()),
});

const sectionActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }),
  z.object({ action: z.literal("review") }),
]);

type SectionRouteContext = { params: Promise<{ caseId: string; sectionKey: string }> };

export async function GET(_request: Request, ctx: SectionRouteContext) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, sectionKey } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");
    if (getSectionDefinition(sectionKey) === null) throw new Error("NotFound");

    const section = await getSectionState(caseId, sectionKey);
    return NextResponse.json({ section });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Section read failed");
  }
}

export async function PUT(request: Request, ctx: SectionRouteContext) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, sectionKey } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    if (getSectionDefinition(sectionKey) === null) throw new Error("NotFound");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = saveDraftSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const section = await saveSectionDraft({
      access,
      sectionKey,
      payload: parsed.data.payload,
    });
    return NextResponse.json({ section });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Section save failed");
  }
}

export async function POST(request: Request, ctx: SectionRouteContext) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, sectionKey } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    if (getSectionDefinition(sectionKey) === null) throw new Error("NotFound");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = sectionActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    if (parsed.data.action === "review") {
      // Per-action gate (CM-121): review is counselor+ only — reject a
      // student attempt before any lib call. The lib re-enforces this
      // fail-closed.
      if (!roleAtLeast(access.role, "counselor")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const section = await reviewSection({ access, sectionKey });
      return NextResponse.json({ section });
    }

    const result = await submitSection({ access, sectionKey });
    return NextResponse.json(result);
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Section action failed");
  }
}
