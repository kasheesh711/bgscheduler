import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listLineWiseActionLogs } from "@/lib/line/data";
import { confirmLineWiseAction } from "@/lib/wise/operations";

const postSchema = z.object({
  actionId: z.string().trim().min(1).max(160),
  selectedSessionIds: z.array(z.string().trim().min(1).max(240)).max(80).optional(),
}).strict();

type RouteContext = { params: Promise<{ reviewId: string }> };

function actorFromSession(session: { user?: { email?: string | null; name?: string | null } } | null) {
  return {
    email: session?.user?.email ?? null,
    name: session?.user?.name ?? null,
  };
}

export async function GET(_request: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { reviewId } = await ctx.params;
  const logs = await listLineWiseActionLogs(getDb(), reviewId);
  return NextResponse.json({ logs });
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

  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { reviewId } = await ctx.params;
  try {
    const result = await confirmLineWiseAction({
      db: getDb(),
      reviewId,
      actionId: parsed.data.actionId,
      selectedSessionIds: parsed.data.selectedSessionIds,
      actor: actorFromSession(session),
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to confirm Wise action";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
