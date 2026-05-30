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
    await updatePayrollReview(getDb(), {
      month: body.month,
      status: body.status,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      actorEmail: session.user.email,
      actorName: session.user.name,
    });
    return NextResponse.json({ ok: true, payload: await getPayrollPayload(getDb(), body.month) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payroll review update failed";
    return NextResponse.json(
      { error: message },
      { status: message.startsWith("Invalid month") ? 400 : 500 },
    );
  }
}
