import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { LeaveRequestSyncAlreadyRunningError, syncLeaveRequests } from "@/lib/leave-requests/sync";

export const maxDuration = 800;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};

  try {
    const result = await syncLeaveRequests(getDb(), {
      triggerType: "manual",
      actorEmail: session.user.email,
      actorName: session.user.name,
      connectedEmail: typeof input.connectedEmail === "string" ? input.connectedEmail : null,
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof LeaveRequestSyncAlreadyRunningError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Leave request sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
