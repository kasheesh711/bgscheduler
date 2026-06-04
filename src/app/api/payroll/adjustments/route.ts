import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { addPayrollAdjustment, getPayrollPayload } from "@/lib/payroll/data";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    month?: string;
    adjustmentType?: string;
    tutorCanonicalKey?: string | null;
    tutorDisplayName?: string | null;
    hours?: number;
    amount?: number;
    description?: string;
  };

  if (!body.month) return NextResponse.json({ error: "month is required" }, { status: 400 });
  if (!body.description?.trim()) return NextResponse.json({ error: "description is required" }, { status: 400 });

  try {
    const adjustment = await addPayrollAdjustment(getDb(), {
      month: body.month,
      adjustmentType: body.adjustmentType ?? "manual",
      tutorCanonicalKey: body.tutorCanonicalKey,
      tutorDisplayName: body.tutorDisplayName,
      hours: Number(body.hours ?? 0),
      amount: Number(body.amount ?? 0),
      description: body.description,
      actorEmail: session.user.email,
      actorName: session.user.name,
    });
    return NextResponse.json({ ok: true, adjustment, payload: await getPayrollPayload(getDb(), body.month) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payroll adjustment failed";
    return NextResponse.json(
      { error: message },
      { status: message.startsWith("Invalid month") ? 400 : 500 },
    );
  }
}
