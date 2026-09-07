import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/admin-users/access";
import { listAdminUsers, updateAdminUserAccess } from "@/lib/admin-users/data";
import { AdminUsersAccessError } from "@/lib/admin-users/types";

const patchSchema = z.object({
  email: z.string().trim().email().max(320),
  disabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative().max(2_147_483_646),
}).strict();

function errorResponse(error: unknown): NextResponse {
  if (error instanceof AdminUsersAccessError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error && typeof error === "object" && "digest" in error) throw error;
  console.error("Admin account access request failed", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: "Could not update or load website access. Try again." }, { status: 500 });
}

export async function GET() {
  try {
    await requireSuperAdmin();
    return NextResponse.json({ rows: await listAdminUsers() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await requireSuperAdmin();
    const body = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Provide an email, disabled state, and current access version." }, { status: 400 });
    const row = await updateAdminUserAccess({
      ...parsed.data,
      actorEmail: actor.email,
      actorAccessVersion: actor.accessVersion,
    });
    return NextResponse.json({ row }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
