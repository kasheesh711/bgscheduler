// Admissions Case Management — meeting log routes (design §4, PRD CM-30/31).
//
// GET lists a case's meetings (minRole student — meetings are visible to the
// student); POST logs a meeting + action-item tasks and PATCH edits a meeting
// (both minRole counselor). requireCaseAccess runs BEFORE body parsing on
// every method (design §4), so membership/role failures never read the body.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import { createMeeting, listMeetings, updateMeeting } from "@/lib/admissions/meetings";

const ROUTE = "/api/admissions/cases/[caseId]/meetings";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected "YYYY-MM-DD"');

// Mirrors ADMISSIONS_TASK_OWNERS (src/lib/admissions/meetings.ts); the lib
// re-validates owners fail-closed, this just gives a 400 instead of a 500.
const actionItemSchema = z.object({
  title: z.string().trim().min(1, "Action item title must not be empty"),
  owner: z.enum(["student", "counselor", "parent"]),
  dueDate: dateOnlySchema.nullish(),
});

const createMeetingSchema = z.object({
  meetingDate: dateOnlySchema,
  mode: z.string().nullish(),
  attendees: z.array(z.string()).optional(),
  notes: z.string().nullish(),
  nextMeetingDate: dateOnlySchema.nullish(),
  actionItems: z.array(actionItemSchema).optional(),
});

const updateMeetingSchema = z.object({
  meetingId: z.string().uuid(),
  meetingDate: dateOnlySchema.optional(),
  mode: z.string().nullish(),
  attendees: z.array(z.string()).optional(),
  notes: z.string().nullish(),
  nextMeetingDate: dateOnlySchema.nullish(),
});

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");

    const meetings = await listMeetings(caseId);
    return NextResponse.json({ meetings });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Meeting list failed");
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

    const parsed = createMeetingSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await createMeeting({
      caseId,
      actorEmail: access.email,
      actorRole: access.role,
      meetingDate: parsed.data.meetingDate,
      mode: parsed.data.mode ?? null,
      attendees: parsed.data.attendees,
      notes: parsed.data.notes ?? null,
      nextMeetingDate: parsed.data.nextMeetingDate ?? null,
      actionItems: parsed.data.actionItems?.map((item) => ({
        title: item.title,
        owner: item.owner,
        dueDate: item.dueDate ?? null,
      })),
    });
    return NextResponse.json(result);
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Meeting create failed");
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

    const parsed = updateMeetingSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const meeting = await updateMeeting({
      caseId,
      meetingId: parsed.data.meetingId,
      actorEmail: access.email,
      actorRole: access.role,
      meetingDate: parsed.data.meetingDate,
      mode: parsed.data.mode,
      attendees: parsed.data.attendees,
      notes: parsed.data.notes,
      nextMeetingDate: parsed.data.nextMeetingDate,
    });
    return NextResponse.json({ meeting });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Meeting update failed");
  }
}
