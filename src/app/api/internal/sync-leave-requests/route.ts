import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { LeaveRequestSyncAlreadyRunningError, syncLeaveRequests } from "@/lib/leave-requests/sync";

export const maxDuration = 800;

async function handle(request: NextRequest) {
  const rejection = rejectInvalidCronSecret(request);
  if (rejection) return rejection;

  try {
    const result = await syncLeaveRequests(getDb(), { triggerType: "cron" });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof LeaveRequestSyncAlreadyRunningError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Leave request sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
