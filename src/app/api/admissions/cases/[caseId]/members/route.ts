// Admissions Case Management — case membership add/revoke/re-invite/email-change.
//
// Design: docs/casemanagementsystem_design.md §4 (`/cases/[caseId]/members`,
// min role counselor for every method — membership edits are counselor-only
// per §2.4). requireCaseAccess runs before body parsing. The adminOverride
// flag (student-as-parent escape hatch) is honored only for admin sessions
// (fail-closed: a counselor sending it gets the normal rejection). A case's
// single student membership is created with the case; POST accepts only
// parent/counselor roles.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import { getCaseDetail } from "@/lib/admissions/cases";
import {
  addMember,
  changeMemberEmail,
  reInvite,
  rejectStudentAsParent,
  revokeMember,
} from "@/lib/admissions/members";
import type { AdmissionsMemberDto } from "@/lib/admissions/types";

interface MembersRouteContext {
  params: Promise<{ caseId: string }>;
}

const AddMemberSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["parent", "counselor"]),
  adminOverride: z.boolean().optional(),
});

const MemberActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("revoke"),
    memberId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("reinvite"),
    memberId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
  }),
  z.object({
    action: z.literal("change_email"),
    memberId: z.string().uuid(),
    newEmail: z.string().trim().email(),
    adminOverride: z.boolean().optional(),
  }),
]);

export async function GET(_request: NextRequest, context: MembersRouteContext) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await context.params;
    await requireCaseAccess(user.email, caseId, "counselor");

    // Membership management needs every status (invited/active/revoked/
    // bounced); getCaseDetail returns all rows, oldest first.
    const detail = await getCaseDetail(caseId);
    return NextResponse.json({ members: detail.members });
  } catch (error) {
    return admissionsErrorResponse(
      "/api/admissions/cases/[caseId]/members",
      error,
      "Members load failed",
    );
  }
}

export async function POST(request: NextRequest, context: MembersRouteContext) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await context.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = AddMemberSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const adminOverride = access.role === "admin" && parsed.data.adminOverride === true;
    if (parsed.data.role === "parent") {
      await rejectStudentAsParent({
        caseId,
        parentEmails: [parsed.data.email],
        adminOverride,
      });
    }

    const member = await addMember({
      caseId,
      email: parsed.data.email,
      role: parsed.data.role,
      actor: { email: access.email, role: access.role },
      adminOverride,
    });

    return NextResponse.json({ member });
  } catch (error) {
    return admissionsErrorResponse(
      "/api/admissions/cases/[caseId]/members",
      error,
      "Member add failed",
    );
  }
}

export async function PATCH(request: NextRequest, context: MembersRouteContext) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await context.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = MemberActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const actor = { email: access.email, role: access.role };

    let member: AdmissionsMemberDto;
    if (parsed.data.action === "revoke") {
      member = await revokeMember({ caseId, memberId: parsed.data.memberId, actor });
    } else if (parsed.data.action === "reinvite") {
      member = await reInvite({
        caseId,
        memberId: parsed.data.memberId,
        actor,
        expectedUpdatedAt: parsed.data.expectedUpdatedAt,
      });
    } else {
      const adminOverride =
        access.role === "admin" && parsed.data.adminOverride === true;
      member = await changeMemberEmail({
        caseId,
        memberId: parsed.data.memberId,
        newEmail: parsed.data.newEmail,
        actor,
        adminOverride,
      });
    }

    return NextResponse.json({ member });
  } catch (error) {
    return admissionsErrorResponse(
      "/api/admissions/cases/[caseId]/members",
      error,
      "Member update failed",
    );
  }
}
