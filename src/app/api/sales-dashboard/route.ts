import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSalesDashboardPayload } from "@/lib/sales-dashboard/data";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await getSalesDashboardPayload(session.user.email);
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load sales dashboard";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
