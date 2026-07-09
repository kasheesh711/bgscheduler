// Admissions Case Management — announcement routes (design §4, PRD CM-90).
//
// Scope rule (mirrors the admissions_announcements_target_check constraint):
// every request targets exactly one of cohortId or caseId — both or neither
// is a 400 before any access check or write.
//
// Access model (fail-closed, always re-resolved from Postgres):
// - GET case-scoped: requireCaseAccess minRole student (family-visible feed).
// - GET cohort-scoped: requireCounselorOrAdmin — cohort-wide listing is a
//   staff surface; students/parents see cohort broadcasts only merged into
//   their own case feed (listAnnouncementsForCase).
// - POST case-scoped: requireCaseAccess minRole counselor on THAT case.
// - POST cohort-scoped: requireCounselorOrAdmin (admin or active registry
//   counselor).
// - PATCH/DELETE: requireCounselorOrAdmin. The target's scope lives on the
//   stored row, not the request — client-supplied scope can never be trusted
//   for rights, so mutations gate on the Postgres-resolved staff check
//   (matches the design §2.2 matrix: announcements are counselor/admin-only
//   writes) and run BEFORE body parsing.
//
// DELETE is a soft delete (announcementId query param); the lib retains the
// row for the audit trail.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
  requireCounselorOrAdmin,
} from "@/lib/admissions/access";
import {
  createAnnouncement,
  listAnnouncementsForCase,
  listAnnouncementsForCohort,
  softDeleteAnnouncement,
  updateAnnouncement,
} from "@/lib/admissions/announcements";

const ROUTE = "/api/admissions/announcements";

const listQuerySchema = z
  .object({
    cohortId: z.string().uuid().optional(),
    caseId: z.string().uuid().optional(),
  })
  .refine((query) => (query.cohortId === undefined) !== (query.caseId === undefined), {
    message: "Exactly one of cohortId or caseId is required",
    path: ["cohortId"],
  });

const createAnnouncementSchema = z
  .object({
    cohortId: z.string().uuid().optional(),
    caseId: z.string().uuid().optional(),
    title: z.string().trim().min(1, "Title must not be empty"),
    body: z.string().trim().min(1, "Body must not be empty"),
  })
  .refine((input) => (input.cohortId === undefined) !== (input.caseId === undefined), {
    message: "Exactly one of cohortId or caseId is required",
    path: ["cohortId"],
  });

const updateAnnouncementSchema = z
  .object({
    announcementId: z.string().uuid(),
    title: z.string().trim().min(1, "Title must not be empty").optional(),
    body: z.string().trim().min(1, "Body must not be empty").optional(),
  })
  .refine((input) => input.title !== undefined || input.body !== undefined, {
    message: "At least one of title or body is required",
    path: ["title"],
  });

const deleteQuerySchema = z.object({
  announcementId: z.string().uuid(),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireAdmissionsSession();

    const searchParams = request.nextUrl.searchParams;
    const parsed = listQuerySchema.safeParse({
      cohortId: searchParams.get("cohortId") ?? undefined,
      caseId: searchParams.get("caseId") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { cohortId, caseId } = parsed.data;
    if (caseId !== undefined) {
      await requireCaseAccess(user.email, caseId, "student");
      const announcements = await listAnnouncementsForCase(caseId);
      return NextResponse.json({ announcements });
    }
    if (cohortId === undefined) {
      // Unreachable after the XOR refine; kept so TS narrowing stays honest.
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    await requireCounselorOrAdmin(user.email);
    const announcements = await listAnnouncementsForCohort(cohortId);
    return NextResponse.json({ announcements });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Announcement list failed");
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAdmissionsSession();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = createAnnouncementSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { cohortId, caseId, title, body: announcementBody } = parsed.data;
    if (caseId !== undefined) {
      const access = await requireCaseAccess(user.email, caseId, "counselor");
      const announcement = await createAnnouncement({
        caseId,
        title,
        body: announcementBody,
        authorEmail: access.email,
        actorRole: access.role,
      });
      return NextResponse.json({ announcement });
    }
    if (cohortId === undefined) {
      // Unreachable after the XOR refine; kept so TS narrowing stays honest.
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const staff = await requireCounselorOrAdmin(user.email);
    const announcement = await createAnnouncement({
      cohortId,
      title,
      body: announcementBody,
      authorEmail: staff.email,
      actorRole: staff.role,
    });
    return NextResponse.json({ announcement });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Announcement create failed");
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireAdmissionsSession();
    const staff = await requireCounselorOrAdmin(user.email);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = updateAnnouncementSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const announcement = await updateAnnouncement({
      announcementId: parsed.data.announcementId,
      actorEmail: staff.email,
      actorRole: staff.role,
      title: parsed.data.title,
      body: parsed.data.body,
    });
    return NextResponse.json({ announcement });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Announcement update failed");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAdmissionsSession();
    const staff = await requireCounselorOrAdmin(user.email);

    const parsed = deleteQuerySchema.safeParse({
      announcementId: request.nextUrl.searchParams.get("announcementId") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    await softDeleteAnnouncement({
      announcementId: parsed.data.announcementId,
      actorEmail: staff.email,
      actorRole: staff.role,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Announcement delete failed");
  }
}
