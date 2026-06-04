import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDataHealthDashboardPayload } from "@/lib/data-health/dashboard";
import { selectModalityIssues as _selectModalityIssues } from "./modality-counter";

export function selectModalityIssues<
  T extends { type: string; entityName: string | null; message: string },
>(
  issues: T[],
): { entityName: string; message: string; issueType: string }[] {
  return _selectModalityIssues(issues);
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await getDataHealthDashboardPayload());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Data health failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
