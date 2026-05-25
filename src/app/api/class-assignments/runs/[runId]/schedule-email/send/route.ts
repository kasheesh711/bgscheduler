import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  type ScheduleEmailSendMode,
  type ScheduleEmailSendOptions,
  type ScheduleEmailSenderKey,
  sendScheduleEmailsForRun,
} from "@/lib/classrooms/schedule-email";

const SENDER_KEYS = new Set<ScheduleEmailSenderKey>(["primary", "backup"]);
const SEND_MODES = new Set<ScheduleEmailSendMode>(["selected", "failed_only"]);

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
  const senderKey = (body as { senderKey?: unknown }).senderKey;
  const mode = (body as { mode?: unknown }).mode;
  const options: ScheduleEmailSendOptions = {};

  if (!Array.isArray(recipientGroupIds) || recipientGroupIds.some((value) => typeof value !== "string")) {
    if (recipientGroupIds !== undefined) {
      throw new Error("recipientGroupIds must be an array of strings.");
    }
  } else {
    options.recipientGroupIds = recipientGroupIds;
  }

  if (senderKey !== undefined) {
    if (typeof senderKey !== "string" || !SENDER_KEYS.has(senderKey as ScheduleEmailSenderKey)) {
      throw new Error("senderKey must be primary or backup.");
    }
    options.senderKey = senderKey as ScheduleEmailSenderKey;
  }

  if (mode !== undefined) {
    if (typeof mode !== "string" || !SEND_MODES.has(mode as ScheduleEmailSendMode)) {
      throw new Error("mode must be selected or failed_only.");
    }
    options.mode = mode as ScheduleEmailSendMode;
  }

  return options;
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
          message === "recipientGroupIds must be an array of strings." ||
          message === "senderKey must be primary or backup." ||
          message === "mode must be selected or failed_only."
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
