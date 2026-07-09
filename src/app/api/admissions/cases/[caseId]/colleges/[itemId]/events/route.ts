// Admissions Case Management — application decision-event routes (design §4,
// PRD CM-43/44).
//
// GET returns one list item's append-only decision chain, oldest first, at
// minRole student (parents get 403); the item is scoped to the case before
// the read (listApplicationEvents is unscoped by design — its JSDoc requires
// this ownership check, so cross-case itemId probing 404s). POST appends one
// dated event (counselor+). A "committed" event routes through
// setCommittedCollege — the canonical CM-44 commit path that moves the
// case's committed pointer and appends the event in ONE transaction — and
// responds { committed } instead of { event }; a second commit while another
// item holds the pointer → 409. The committed branch takes no notes (the
// CM-44 pointer move records none). requireCaseAccess runs BEFORE body
// parsing on every method (design §4).

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  addApplicationEvent,
  listApplicationEvents,
  listCollegesForCase,
  setCommittedCollege,
} from "@/lib/admissions/colleges";

const ROUTE = "/api/admissions/cases/[caseId]/colleges/[itemId]/events";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected "YYYY-MM-DD"');

// Mirrors ADMISSIONS_DECISION_EVENTS (src/lib/admissions/colleges.ts):
// "committed" is split into its own branch so it can route through
// setCommittedCollege; the lib re-validates events fail-closed, this just
// gives a 400 instead of a 500.
const postEventSchema = z.union([
  z.object({
    event: z.literal("committed"),
    eventDate: dateOnlySchema,
  }),
  z.object({
    event: z.enum([
      "submitted",
      "deferred",
      "waitlisted",
      "accepted",
      "denied",
      "withdrawn",
    ]),
    eventDate: dateOnlySchema,
    notes: z.string().nullish(),
  }),
]);

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string; itemId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");

    // Ownership check: the itemId must be one of THIS case's live list rows
    // (malformed or cross-case ids fall out here and 404).
    const colleges = await listCollegesForCase(caseId);
    if (!colleges.some((row) => row.id === itemId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const events = await listApplicationEvents(itemId);
    return NextResponse.json({ events });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Event list failed");
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ caseId: string; itemId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId, itemId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = postEventSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    if (parsed.data.event === "committed") {
      const committed = await setCommittedCollege({
        access,
        listItemId: itemId,
        eventDate: parsed.data.eventDate,
      });
      return NextResponse.json({ committed });
    }

    const event = await addApplicationEvent({
      access,
      listItemId: itemId,
      event: parsed.data.event,
      eventDate: parsed.data.eventDate,
      notes: parsed.data.notes,
    });
    return NextResponse.json({ event });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Event append failed");
  }
}
