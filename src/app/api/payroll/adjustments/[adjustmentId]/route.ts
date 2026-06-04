import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { deletePayrollAdjustment } from "@/lib/payroll/data";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ adjustmentId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { adjustmentId } = await context.params;
  const deleted = await deletePayrollAdjustment(getDb(), adjustmentId);
  if (!deleted) {
    return NextResponse.json({ error: "Adjustment not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
