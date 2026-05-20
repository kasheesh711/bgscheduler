import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  createSchedulerConversation,
  listSchedulerConversations,
} from "@/lib/ai/scheduler-data";

const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  customerParentName: z.string().trim().max(120).optional(),
  customerStudentName: z.string().trim().max(120).optional(),
  customerContact: z.string().trim().max(160).optional(),
  notes: z.string().max(4000).optional(),
}).strict();

function actorFromSession(session: { user?: { email?: string | null; name?: string | null } } | null) {
  return {
    email: session?.user?.email ?? null,
    name: session?.user?.name ?? null,
  };
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "true";
  const mineOnly = request.nextUrl.searchParams.get("scope") === "mine";
  const query = request.nextUrl.searchParams.get("q") ?? undefined;
  const conversations = await listSchedulerConversations(getDb(), {
    includeArchived,
    mineOnly,
    query,
    actor: actorFromSession(session),
  });

  return NextResponse.json({ conversations });
}

export async function POST(request: NextRequest) {
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

  const parsed = createConversationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const conversation = await createSchedulerConversation(getDb(), actorFromSession(session), parsed.data);
  return NextResponse.json({ conversation }, { status: 201 });
}
