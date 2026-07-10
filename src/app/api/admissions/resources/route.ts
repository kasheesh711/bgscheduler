// Admissions Case Management — resource library routes (design §4, PRD CM-92).
//
// Access model (fail-closed, always re-resolved from Postgres for writes):
// - GET: requireAdmissionsSession only — the library is global and
//   deliberately readable by EVERY admissions role (counselor, admin,
//   student, parent); there is no per-case scope to anchor requireCaseAccess.
// - POST/PATCH/DELETE: requireCounselorOrAdmin (admin_users row or an ACTIVE
//   admissions_counselors registry row) BEFORE body parsing — the JWT role
//   claim is never trusted for rights.
//
// DELETE is a soft delete (resourceId query param); the lib retains the row
// for the audit trail.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCounselorOrAdmin,
} from "@/lib/admissions/access";
import {
  admissionsResourceUrlSchema,
  createResource,
  isAdmissionsResourceTopic,
  listResources,
  softDeleteResource,
  updateResource,
} from "@/lib/admissions/resources";

const ROUTE = "/api/admissions/resources";

const topicSchema = z
  .string()
  .refine(isAdmissionsResourceTopic, { message: "Unknown topic" });

const createResourceSchema = z.object({
  topic: topicSchema,
  title: z.string().trim().min(1, "Title must not be empty"),
  url: admissionsResourceUrlSchema,
  sortOrder: z.coerce.number().int().min(0).optional(),
});

const updateResourceSchema = z
  .object({
    resourceId: z.string().uuid(),
    topic: topicSchema.optional(),
    title: z.string().trim().min(1, "Title must not be empty").optional(),
    url: admissionsResourceUrlSchema.optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
  })
  .refine(
    (input) =>
      input.topic !== undefined ||
      input.title !== undefined ||
      input.url !== undefined ||
      input.sortOrder !== undefined,
    {
      message: "At least one of topic, title, url, or sortOrder is required",
      path: ["topic"],
    },
  );

const deleteQuerySchema = z.object({
  resourceId: z.string().uuid(),
});

export async function GET() {
  try {
    await requireAdmissionsSession();

    const groups = await listResources();
    return NextResponse.json({ groups });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Resource list failed");
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAdmissionsSession();
    const staff = await requireCounselorOrAdmin(user.email);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = createResourceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const resource = await createResource({
      topic: parsed.data.topic,
      title: parsed.data.title,
      url: parsed.data.url,
      sortOrder: parsed.data.sortOrder,
      actorEmail: staff.email,
      actorRole: staff.role,
    });
    return NextResponse.json({ resource });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Resource create failed");
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

    const parsed = updateResourceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const resource = await updateResource({
      resourceId: parsed.data.resourceId,
      actorEmail: staff.email,
      actorRole: staff.role,
      topic: parsed.data.topic,
      title: parsed.data.title,
      url: parsed.data.url,
      sortOrder: parsed.data.sortOrder,
    });
    return NextResponse.json({ resource });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Resource update failed");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAdmissionsSession();
    const staff = await requireCounselorOrAdmin(user.email);

    const parsed = deleteQuerySchema.safeParse({
      resourceId: request.nextUrl.searchParams.get("resourceId") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    await softDeleteResource({
      resourceId: parsed.data.resourceId,
      actorEmail: staff.email,
      actorRole: staff.role,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Resource delete failed");
  }
}
