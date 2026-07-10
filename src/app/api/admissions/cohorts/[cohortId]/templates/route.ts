// Admissions Case Management — cohort checklist-template routes (design §4,
// PRD CM-20/CM-21).
//
// GET returns the latest template version (with items) plus the full version
// history (counselor+ — read-only visibility for staff). POST is admin-only
// and multiplexes via body.action: "create_version" adds version max + 1
// (CM-20 immutability-by-versioning) and "push_new_items" appends the latest
// published template's missing items to every live case in the cohort
// (CM-21). PATCH publishes a draft version (admin only); publishing twice is
// a 409 and a templateId outside this cohort is a 404 (fail-closed — no
// cross-cohort publishing through the wrong URL).
//
// Staff/admin rights are re-resolved from Postgres on EVERY request
// (requireCounselorOrAdmin / requireAdmissionsAdmin, design §2.2) — the JWT
// role claim shapes nav only, so registry deactivation and admin removal
// revoke template management instantly.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsAdmin,
  requireAdmissionsSession,
  requireCounselorOrAdmin,
} from "@/lib/admissions/access";
import {
  createTemplateVersion,
  getLatestTemplate,
  listTemplateVersions,
  publishTemplate,
  pushNewItemsToCohortCases,
} from "@/lib/admissions/checklists";

const ROUTE = "/api/admissions/cohorts/[cohortId]/templates";

// Mirrors ADMISSIONS_CHECKLIST_PHASES keys (src/lib/admissions/config.ts);
// template items must sit in a canonical phase ("custom" is task-only). The
// lib re-validates fail-closed, this just gives a 400 instead of a 500.
const templatePhaseSchema = z.enum([
  "about_you",
  "academics",
  "testing",
  "activities",
  "college_research",
  "essays",
  "recommendations",
  "applications",
  "decisions_aid",
  "transition",
]);

const templateItemSchema = z.object({
  itemKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "Expected a snake_case item key"),
  phase: templatePhaseSchema,
  title: z.string().trim().min(1, "Item title must not be empty"),
  description: z.string().nullish(),
  defaultOwner: z.enum(["student", "counselor"]),
  sortOrder: z.coerce.number().int().min(0),
});

const postTemplateSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_version"),
    items: z.array(templateItemSchema).min(1, "Template requires at least one item"),
    name: z.string().trim().min(1).optional(),
    publish: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("push_new_items"),
  }),
]);

const publishTemplateSchema = z.object({ templateId: z.string().uuid() });

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ cohortId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    await requireCounselorOrAdmin(user.email);
    const { cohortId } = await ctx.params;

    const latest = await getLatestTemplate(cohortId);
    const versions = await listTemplateVersions(cohortId);
    return NextResponse.json({ latest, versions });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Template load failed");
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ cohortId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const admin = await requireAdmissionsAdmin(user.email);
    const { cohortId } = await ctx.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = postTemplateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const actor = { email: admin.email, role: admin.role };

    if (parsed.data.action === "push_new_items") {
      const result = await pushNewItemsToCohortCases(cohortId, actor);
      return NextResponse.json(result);
    }

    const template = await createTemplateVersion(
      cohortId,
      parsed.data.items.map((item) => ({
        itemKey: item.itemKey,
        phase: item.phase,
        title: item.title,
        description: item.description ?? null,
        defaultOwner: item.defaultOwner,
        sortOrder: item.sortOrder,
      })),
      actor,
      { name: parsed.data.name, publish: parsed.data.publish },
    );
    return NextResponse.json({ template });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Template action failed");
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ cohortId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const admin = await requireAdmissionsAdmin(user.email);
    const { cohortId } = await ctx.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = publishTemplateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // Fail-closed cohort scoping: only versions belonging to THIS cohort are
    // publishable through this URL (publishTemplate itself is id-keyed).
    const versions = await listTemplateVersions(cohortId);
    if (!versions.some((version) => version.id === parsed.data.templateId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const template = await publishTemplate(parsed.data.templateId, {
      email: admin.email,
      role: admin.role,
    });
    return NextResponse.json({ template });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Template publish failed");
  }
}
