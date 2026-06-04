import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getPayrollPayload, updatePayrollReview } from "@/lib/payroll/data";

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    month?: string;
    status?: "draft" | "approved";
    notes?: string;
  };

  if (!body.month) {
    return NextResponse.json({ error: "month is required" }, { status: 400 });
  }
  if (body.status !== undefined && body.status !== "draft" && body.status !== "approved") {
    return NextResponse.json({ error: "Invalid review status" }, { status: 400 });
  }

  try {
    const db = getDb();
    if (body.status === "approved") {
      const payload = await getPayrollPayload(db, body.month);
      const blockingRateIssues = payload.issues.filter((issue) => (
        issue.type === "expected_rate_mismatch"
        || issue.type === "missing_expected_rate_rule"
        || issue.type === "unmapped_rate_course"
      ));
      if (blockingRateIssues.length > 0) {
        return NextResponse.json(
          { error: `Cannot approve payroll with ${blockingRateIssues.length} unresolved expected-rate issue(s).` },
          { status: 409 },
        );
      }
    }

    await updatePayrollReview(db, {
      month: body.month,
      status: body.status,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      actorEmail: session.user.email,
      actorName: session.user.name,
    });
    return NextResponse.json({ ok: true, payload: await getPayrollPayload(db, body.month) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payroll review update failed";
    return NextResponse.json(
      { error: message },
      { status: message.startsWith("Invalid month") ? 400 : 500 },
    );
  }
}
