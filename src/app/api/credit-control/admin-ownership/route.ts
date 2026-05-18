import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { requireCreditControlSession, creditControlErrorResponse } from "@/lib/credit-control/api";
import { CREDIT_CONTROL_CACHE_TAG, getAdminViewOptions } from "@/lib/credit-control/config";
import { upsertCreditAdminOwnership } from "@/lib/credit-control/db";

export async function POST(request: Request) {
  try {
    const sessionUser = await requireCreditControlSession();
    const body = (await request.json()) as { studentKey?: string; adminKey?: string };
    const studentKey = String(body.studentKey ?? "").trim();
    const adminKey = String(body.adminKey ?? "").trim();

    if (!studentKey || !adminKey) {
      return NextResponse.json({ error: "studentKey and adminKey are required" }, { status: 400 });
    }

    if (!getAdminViewOptions().some((option) => option.key === adminKey)) {
      return NextResponse.json({ error: "Unknown adminKey" }, { status: 400 });
    }

    await upsertCreditAdminOwnership({
      studentKey,
      adminKey,
      assignedByEmail: sessionUser.email,
    });
    revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true, studentKey, adminKey });
  } catch (error) {
    return creditControlErrorResponse(
      "/api/credit-control/admin-ownership",
      error,
      "Admin ownership update failed",
    );
  }
}
