import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  getLeaveRequestDetail,
  LEAVE_WORKFLOW_STATUSES,
  updateLeaveRequestWorkflow,
  type LeaveWorkflowStatus,
} from "@/lib/leave-requests/data";
import { resolveLeaveRequestsConnectedEmail } from "@/lib/leave-requests/sync";

type Context = { params: Promise<{ requestId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { requestId } = await context.params;
  const detail = await getLeaveRequestDetail(getDb(), requestId);
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(detail);
}

export async function PATCH(request: NextRequest, context: Context) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { requestId } = await context.params;
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const workflowStatus = typeof input.workflowStatus === "string" ? input.workflowStatus : undefined;
  if (workflowStatus && !LEAVE_WORKFLOW_STATUSES.includes(workflowStatus as LeaveWorkflowStatus)) {
    return NextResponse.json({ error: "Invalid workflow status" }, { status: 400 });
  }

  const db = getDb();
  let connectedEmail: string | null = null;
  try {
    connectedEmail = await resolveLeaveRequestsConnectedEmail(db, session.user.email, true);
  } catch {
    connectedEmail = null;
  }

  try {
    const result = await updateLeaveRequestWorkflow(db, requestId, {
      workflowStatus: workflowStatus as LeaveWorkflowStatus | undefined,
      staffNote: typeof input.staffNote === "string" ? input.staffNote : input.staffNote === null ? null : undefined,
      sheetStatusText: Object.prototype.hasOwnProperty.call(input, "sheetStatusText")
        ? typeof input.sheetStatusText === "string" ? input.sheetStatusText : null
        : undefined,
      retrySheetWrite: input.retrySheetWrite === true,
      actorEmail: session.user.email,
      actorName: session.user.name,
      connectedEmail,
    });
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Leave request update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
