import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listRecentSalesDashboardImportRuns } from "@/lib/sales-dashboard/data";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const runs = await listRecentSalesDashboardImportRuns();
    return NextResponse.json({ runs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list sales imports";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
