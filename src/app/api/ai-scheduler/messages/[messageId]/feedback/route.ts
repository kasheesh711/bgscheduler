import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { createSchedulerFeedback } from "@/lib/ai/scheduler-data";
import { getDb } from "@/lib/db";

const feedbackSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("accept"),
    conversationId: z.string().uuid().nullable().optional(),
    schedulerRunId: z.string().uuid().nullable().optional(),
    selectedTutorIds: z.array(z.string().min(1)).max(12).optional(),
    editedParentDraft: z.string().max(5000).nullable().optional(),
  }).strict(),
  z.object({
    action: z.literal("edit"),
    conversationId: z.string().uuid().nullable().optional(),
    schedulerRunId: z.string().uuid().nullable().optional(),
    selectedTutorIds: z.array(z.string().min(1)).max(12).optional(),
    editedParentDraft: z.string().trim().min(1).max(5000),
  }).strict(),
  z.object({
    action: z.literal("reject"),
    conversationId: z.string().uuid().nullable().optional(),
    schedulerRunId: z.string().uuid().nullable().optional(),
    rejectedTutorIds: z.array(z.string().min(1)).max(12).optional(),
    rejectionReason: z.string().trim().min(1).max(500),
    staffCorrection: z.string().trim().min(1).max(5000),
  }).strict(),
]);

type RouteContext = { params: Promise<{ messageId: string }> };

function actorFromSession(session: { user?: { email?: string | null; name?: string | null } } | null) {
  return {
    email: session?.user?.email ?? null,
    name: session?.user?.name ?? null,
  };
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = feedbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { messageId } = await ctx.params;
  const db = getDb();
  const feedback = await createSchedulerFeedback(db, {
    messageId,
    conversationId: parsed.data.conversationId ?? null,
    schedulerRunId: parsed.data.schedulerRunId ?? null,
    action: parsed.data.action,
    selectedTutorIds: "selectedTutorIds" in parsed.data ? parsed.data.selectedTutorIds : undefined,
    rejectedTutorIds: "rejectedTutorIds" in parsed.data ? parsed.data.rejectedTutorIds : undefined,
    editedParentDraft: "editedParentDraft" in parsed.data ? parsed.data.editedParentDraft : undefined,
    rejectionReason: "rejectionReason" in parsed.data ? parsed.data.rejectionReason : undefined,
    staffCorrection: "staffCorrection" in parsed.data ? parsed.data.staffCorrection : undefined,
    actor: actorFromSession(session),
  });

  return NextResponse.json({ feedback });
}
