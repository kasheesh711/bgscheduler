import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { admissionsErrorResponse, requireAdmissionsSession } from "@/lib/admissions/access";
import { deactivateCounselor, listCounselors, upsertCounselor } from "@/lib/admissions/counselors";
import type { AdmissionsSessionUser } from "@/lib/admissions/types";

const UpsertCounselorSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1),
  active: z.boolean().default(true),
});

// PATCH accepts either a full update (name + explicit active — never guess the
// flag) or a pure deactivation ({ email, active: false } with no name). Order
// matters: the update variant wins when both name and active are present.
const PatchCounselorSchema = z.union([
  z.object({
    email: z.string().email(),
    name: z.string().trim().min(1),
    active: z.boolean(),
  }),
  z.object({
    email: z.string().email(),
    active: z.literal(false),
  }),
]);

function requireAdmin(user: AdmissionsSessionUser): NextResponse | null {
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * GET /api/admissions/counselors — lists the full counselor registry, active
 * and inactive (admin only — the registry grants sign-in capability).
 */
export async function GET() {
  try {
    const user = await requireAdmissionsSession();
    const forbidden = requireAdmin(user);
    if (forbidden) return forbidden;

    const counselors = await listCounselors();
    return NextResponse.json({ counselors });
  } catch (error) {
    return admissionsErrorResponse("/api/admissions/counselors", error, "Counselors load failed");
  }
}

/**
 * POST /api/admissions/counselors — creates (or upserts by lowercase email) a
 * counselor registry row (admin only); the write is audited transactionally.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAdmissionsSession();
    const forbidden = requireAdmin(user);
    if (forbidden) return forbidden;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = UpsertCounselorSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const counselor = await upsertCounselor(
      parsed.data.email,
      parsed.data.name,
      parsed.data.active,
      { email: user.email, role: user.role },
    );
    return NextResponse.json({ counselor });
  } catch (error) {
    return admissionsErrorResponse("/api/admissions/counselors", error, "Counselor creation failed");
  }
}

/**
 * PATCH /api/admissions/counselors — updates a registry row (admin only).
 * `{ email, name, active }` upserts; `{ email, active: false }` deactivates
 * (revokes counselor sign-in; unknown email → 404 via Error("NotFound")).
 */
export async function PATCH(request: NextRequest) {
  try {
    const user = await requireAdmissionsSession();
    const forbidden = requireAdmin(user);
    if (forbidden) return forbidden;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = PatchCounselorSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const actor = { email: user.email, role: user.role };
    const counselor =
      "name" in parsed.data
        ? await upsertCounselor(parsed.data.email, parsed.data.name, parsed.data.active, actor)
        : await deactivateCounselor(parsed.data.email, actor);
    return NextResponse.json({ counselor });
  } catch (error) {
    return admissionsErrorResponse("/api/admissions/counselors", error, "Counselor update failed");
  }
}
