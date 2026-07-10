// Admissions Case Management — parent dashboard route (design §2.3/§4/§5.3,
// PRD CM-130).
//
// GET serves the closed parent projection and NOTHING else: the response body
// is buildParentDashboard's DTO — the ONLY builder of parent-facing payloads —
// so a staff field can never reach this surface without a deliberate edit to
// parent-projection.ts (leaks are structural, not conventional). minRole is
// "parent", the floor of the parent < student < counselor < admin ordering,
// so EVERY active member may read: parents get their own surface, students
// see the same view, and counselors/admins preview exactly what the family
// sees (design §4). requireCaseAccess still runs on every request — strangers
// and revoked members 403, and for non-admins a missing case stays Forbidden,
// never NotFound, so case existence does not leak.

import { NextResponse } from "next/server";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import { buildParentDashboard } from "@/lib/admissions/parent-projection";

const ROUTE = "/api/admissions/cases/[caseId]/parent-dashboard";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "parent");

    const dashboard = await buildParentDashboard(caseId);
    return NextResponse.json({ dashboard });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Parent dashboard load failed");
  }
}
