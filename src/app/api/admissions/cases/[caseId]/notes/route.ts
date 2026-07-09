// Admissions Case Management — case-note routes (design §4, PRD CM-91).
//
// GET lists notes shaped for the reader's per-case role (minRole student;
// listNotesForRole strips staff_only for non-staff readers). POST creates a
// note with an EXPLICIT visibility — the field is required in the schema with
// no default, matching the NOT-NULL-no-default column. PATCH changes a note's
// visibility. Both writes are minRole counselor. requireCaseAccess runs
// BEFORE body parsing on every method (design §4).

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import { createNote, listNotesForRole, updateNoteVisibility } from "@/lib/admissions/notes";

const ROUTE = "/api/admissions/cases/[caseId]/notes";

// Mirrors ADMISSIONS_NOTE_VISIBILITIES (src/lib/admissions/notes.ts). The
// field is deliberately required with NO default — every write carries an
// explicit audience choice (CM-91).
const noteVisibilitySchema = z.enum(["staff_only", "shared_with_family"]);

const createNoteSchema = z.object({
  body: z.string().trim().min(1, "Note body must not be empty"),
  visibility: noteVisibilitySchema,
});

const updateNoteVisibilitySchema = z.object({
  noteId: z.string().uuid(),
  visibility: noteVisibilitySchema,
});

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");

    const notes = await listNotesForRole(caseId, access.role);
    return NextResponse.json({ notes });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Note list failed");
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

    const parsed = createNoteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const note = await createNote({
      caseId,
      authorEmail: access.email,
      actorRole: access.role,
      body: parsed.data.body,
      visibility: parsed.data.visibility,
    });
    return NextResponse.json({ note });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Note create failed");
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

    const parsed = updateNoteVisibilitySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const note = await updateNoteVisibility({
      caseId,
      noteId: parsed.data.noteId,
      actorEmail: access.email,
      actorRole: access.role,
      visibility: parsed.data.visibility,
    });
    return NextResponse.json({ note });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Note update failed");
  }
}
