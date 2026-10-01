import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/admin-users/access";
import { getDb } from "@/lib/db";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { changeGrant, listGrants } from "@/lib/tutor-offboarding/grants";

const GrantBody = z.object({
  action: z.enum(["grant", "revoke"]),
  email: z.email().max(320),
}).strict();

/** OFF-11: who may remove tutors from Wise. Owner only. */
export async function GET() {
  try {
    await requireSuperAdmin();
    return NextResponse.json({ grants: await listGrants() });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] grants read failed", error, "The removal access list could not load.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const owner = await requireSuperAdmin();
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      throw new TutorOffboardingError("Invalid JSON body.", 400);
    }
    const parsed = GrantBody.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const grants = await changeGrant(getDb(), { action: parsed.data.action, email: parsed.data.email, actorEmail: owner.email });
    return NextResponse.json({ ok: true, grants });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] grant change failed", error, "The removal access could not be changed.");
  }
}
