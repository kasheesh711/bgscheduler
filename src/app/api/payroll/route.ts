import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { getPayrollPayload } from "@/lib/payroll/data";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const month = request.nextUrl.searchParams.get("month") ?? todayBangkok().slice(0, 7);
  try {
    return NextResponse.json(await getPayrollPayload(getDb(), month));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load payroll";
    return NextResponse.json(
      { error: message },
      { status: message.startsWith("Invalid month") ? 400 : 500 },
    );
  }
}
