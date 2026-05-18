import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  type ScheduleEmailSendOptions,
  sendScheduleEmailsForRun,
} from "@/lib/classrooms/schedule-email";

async function parseSendOptions(request: Request): Promise<ScheduleEmailSendOptions> {
  const raw = await request.text();
  if (!raw.trim()) return {};

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body.");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be an object.");
  }

  const recipientGroupIds = (body as { recipientGroupIds?: unknown }).recipientGroupIds;
  if (recipientGroupIds === undefined) return {};
  if (!Array.isArray(recipientGroupIds) || recipientGroupIds.some((value) => typeof value !== "string")) {
    throw new Error("recipientGroupIds must be an array of strings.");
  }

  return { recipientGroupIds };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;
  try {
    const options = await parseSendOptions(request);
    const result = await sendScheduleEmailsForRun(
      getDb(),
      runId,
      session.user?.email ?? null,
      undefined,
      options,
    );
    const status = result.summary.attempted > 0 ? 200 : 409;
    return NextResponse.json(result, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send schedule emails";
    const status = message === "Assignment run not found"
      ? 404
      : message === "Invalid JSON body." ||
          message === "Request body must be an object." ||
          message === "recipientGroupIds must be an array of strings."
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
