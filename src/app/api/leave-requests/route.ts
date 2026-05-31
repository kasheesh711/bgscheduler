import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getGoogleTokenStatus } from "@/lib/sales-dashboard/google-oauth";
import { listLeaveRequests } from "@/lib/leave-requests/data";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  try {
    const data = await listLeaveRequests(getDb(), {
      status: params.get("status") ?? undefined,
      q: params.get("q") ?? undefined,
      startDate: params.get("startDate") ?? undefined,
      endDate: params.get("endDate") ?? undefined,
      summaryOnly: params.get("summaryOnly") === "true",
    });
    const googleSheets = await getGoogleTokenStatus(session.user.email);
    return NextResponse.json({ ...data, googleSheets });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Leave request query failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
