import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  getSchedulerConversationWithMessages,
  patchSchedulerConversation,
} from "@/lib/ai/scheduler-data";

const patchConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  customerParentName: z.string().trim().max(120).nullable().optional(),
  customerStudentName: z.string().trim().max(120).nullable().optional(),
  customerContact: z.string().trim().max(160).nullable().optional(),
  notes: z.string().max(4000).optional(),
  status: z.enum(["active", "archived"]).optional(),
}).strict();

type ConversationRouteContext = { params: Promise<{ conversationId: string }> };

async function conversationIdFromContext(ctx: ConversationRouteContext) {
  const params = await ctx.params;
  return params.conversationId;
}

export async function GET(
  _request: NextRequest,
  ctx: ConversationRouteContext,
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const conversationId = await conversationIdFromContext(ctx);
  const result = await getSchedulerConversationWithMessages(getDb(), conversationId);
  if (!result) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  return NextResponse.json(result);
}

export async function PATCH(
  request: NextRequest,
  ctx: ConversationRouteContext,
) {
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

  const parsed = patchConversationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const conversationId = await conversationIdFromContext(ctx);
  const conversation = await patchSchedulerConversation(getDb(), conversationId, parsed.data);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  return NextResponse.json({ conversation });
}

export async function DELETE(
  _request: NextRequest,
  ctx: ConversationRouteContext,
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const conversationId = await conversationIdFromContext(ctx);
  const conversation = await patchSchedulerConversation(getDb(), conversationId, { status: "archived" });
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  return NextResponse.json({ conversation });
}
