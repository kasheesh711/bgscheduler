import { NextResponse } from "next/server";
import { z } from "zod";

import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "@/lib/admissions/communications";

const ROUTE = "/api/admissions/notification-preferences";
const caseIdSchema = z.string().uuid();
const valueSchema = z.enum(["default", "digest", "off"]);
const updateSchema = z.object({
  caseId: caseIdSchema,
  announcements: valueSchema,
  tasks: valueSchema,
  comments: valueSchema,
}).strict();

export async function GET(request: Request) {
  try {
    const user = await requireAdmissionsSession();
    const parsed = caseIdSchema.safeParse(new URL(request.url).searchParams.get("caseId"));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const access = await requireCaseAccess(user.email, parsed.data, "parent");
    return NextResponse.json({
      preferences: await getNotificationPreferences(parsed.data, access.email),
    });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Notification preferences load failed");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireAdmissionsSession();
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    const access = await requireCaseAccess(user.email, parsed.data.caseId, "parent");
    assertCaseMutationAllowed(access);
    return NextResponse.json({ preferences: await updateNotificationPreferences({ access, ...parsed.data }) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Notification preferences update failed");
  }
}
