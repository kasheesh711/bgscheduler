// Staff/admin rights are re-resolved from Postgres on EVERY request
// (requireCounselorOrAdmin / requireAdmissionsAdmin, design §2.2) — the JWT
// role claim shapes nav only, so registry deactivation and admin removal
// revoke these surfaces instantly.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsAdmin,
  requireAdmissionsSession,
  requireCounselorOrAdmin,
} from "@/lib/admissions/access";
import { createCohort, listCohorts } from "@/lib/admissions/cohorts";

const CreateCohortSchema = z.object({
  name: z.string().trim().min(1),
  graduationYear: z.coerce.number().int().min(2000).max(2100),
});

/**
 * GET /api/admissions/cohorts — lists all cohorts (counselor and above;
 * students/parents have no cohort-registry view).
 */
export async function GET() {
  try {
    const user = await requireAdmissionsSession();
    await requireCounselorOrAdmin(user.email);

    const cohorts = await listCohorts();
    return NextResponse.json({ cohorts });
  } catch (error) {
    return admissionsErrorResponse("/api/admissions/cohorts", error, "Cohorts load failed");
  }
}

/**
 * POST /api/admissions/cohorts — creates a cohort (admin only, design §4).
 * A duplicate name surfaces from createCohort as Error("Conflict") → 409.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAdmissionsSession();
    await requireAdmissionsAdmin(user.email);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = CreateCohortSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const cohort = await createCohort(parsed.data.name, parsed.data.graduationYear);
    return NextResponse.json({ cohort });
  } catch (error) {
    return admissionsErrorResponse("/api/admissions/cohorts", error, "Cohort creation failed");
  }
}
