import { NextResponse } from "next/server";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
} from "@/lib/admissions/access";
import { listLinkedFamilyCases } from "@/lib/admissions/family-cases";

const ROUTE = "/api/admissions/family-cases";

/** GET — parent-only list used by the sibling switcher. */
export async function GET() {
  try {
    const user = await requireAdmissionsSession();
    if (user.role !== "parent") throw new Error("Forbidden");
    return NextResponse.json({ cases: await listLinkedFamilyCases(user.email) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Family cases load failed");
  }
}
