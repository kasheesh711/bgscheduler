import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { sendScheduleEmailsForRun } from "@/lib/classrooms/schedule-email";

async function parseRecipientGroupIds(request: Request): Promise<string[] | undefined> {
  const text = await request.text();
  if (!text.trim()) return undefined;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body.");
  }

  if (!body || typeof body !== "object" || !("recipientGroupIds" in body)) {
    return undefined;
  }

  const recipientGroupIds = (body as { recipientGroupIds?: unknown }).recipientGroupIds;
  if (!Array.isArray(recipientGroupIds) || recipientGroupIds.some((value) => typeof value !== "string")) {
    throw new Error("recipientGroupIds must be an array of strings.");
  }
  return recipientGroupIds;
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
  let recipientGroupIds: string[] | undefined;
  try {
    recipientGroupIds = await parseRecipientGroupIds(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const result = recipientGroupIds === undefined
      ? await sendScheduleEmailsForRun(
        getDb(),
        runId,
        session.user?.email ?? null,
      )
      : await sendScheduleEmailsForRun(
        getDb(),
        runId,
        session.user?.email ?? null,
        undefined,
        { recipientGroupIds },
      );
    const status = result.summary.attempted > 0 ? 200 : 409;
    return NextResponse.json(result, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send schedule emails";
    const status = message === "Assignment run not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
