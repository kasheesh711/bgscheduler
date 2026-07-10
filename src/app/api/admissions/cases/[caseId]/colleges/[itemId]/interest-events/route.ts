import { NextResponse } from "next/server";
import { z } from "zod";

import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  createInterestEvent,
  deleteInterestEvent,
  INTEREST_EVENT_TYPES,
  listInterestEvents,
  updateInterestEvent,
} from "@/lib/admissions/college-details";

const ROUTE = "/api/admissions/cases/[caseId]/colleges/[listItemId]/interest-events";
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const typeSchema = z.enum(INTEREST_EVENT_TYPES);
const createSchema = z.object({
  type: typeSchema,
  eventDate: dateOnly,
  notes: z.string().max(10_000).nullish(),
});
const updateSchema = z.object({
  eventId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(),
  type: typeSchema.optional(),
  eventDate: dateOnly.optional(),
  notes: z.string().max(10_000).nullish(),
});
const deleteSchema = z.object({ eventId: z.string().uuid() });
type Context = { params: Promise<{ caseId: string; itemId: string }> };

export async function GET(_request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");
    return NextResponse.json({ events: await listInterestEvents(caseId, itemId) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Interest events load failed");
  }
}

export async function POST(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    assertCaseMutationAllowed(access);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    return NextResponse.json({ event: await createInterestEvent({ access, listItemId: itemId, ...parsed.data }) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Interest event create failed");
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
    return NextResponse.json({ event: await updateInterestEvent({ access, listItemId: itemId, ...parsed.data }) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Interest event update failed");
  }
}

export async function DELETE(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    assertCaseMutationAllowed(access);
    const parsed = deleteSchema.safeParse({ eventId: new URL(request.url).searchParams.get("eventId") });
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    await deleteInterestEvent({ access, listItemId: itemId, eventId: parsed.data.eventId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Interest event delete failed");
  }
}
