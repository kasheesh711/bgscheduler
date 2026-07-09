// Admissions Case Management — per-case calendar route (design §4, CM-100..102).
//
// GET aggregates a case's dated items for an inclusive "YYYY-MM-DD" window
// plus the open upcoming-deadlines panel (minRole student; the parent-shaped
// projection arrives with parent-projection.ts in a later phase).
// requireCaseAccess runs BEFORE query parsing (design §4), so membership/role
// failures never depend on the query string. Window bounds are validated
// fail-closed: both required, date-only, from <= to — malformed input is a
// 400, never a guessed window.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  buildCaseCalendar,
  getUpcomingDeadlines,
  UPCOMING_DEADLINES_DEFAULT_LIMIT,
  UPCOMING_DEADLINES_MAX_LIMIT,
} from "@/lib/admissions/calendar";

const ROUTE = "/api/admissions/cases/[caseId]/calendar";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected "YYYY-MM-DD"');

const calendarQuerySchema = z
  .object({
    from: dateOnlySchema,
    to: dateOnlySchema,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(UPCOMING_DEADLINES_MAX_LIMIT)
      .default(UPCOMING_DEADLINES_DEFAULT_LIMIT),
  })
  .refine((query) => query.from <= query.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");

    const searchParams = request.nextUrl.searchParams;
    const parsed = calendarQuerySchema.safeParse({
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { from, to, limit } = parsed.data;
    const items = await buildCaseCalendar(caseId, { from, to });
    const upcoming = await getUpcomingDeadlines(caseId, limit);
    return NextResponse.json({ items, upcoming });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Calendar load failed");
  }
}
