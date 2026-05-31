import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createWiseCancelPreview } from "@/lib/leave-requests/data";

type Context = { params: Promise<{ requestId: string }> };

export async function POST(request: NextRequest, context: Context) {
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
  const affectedSessionIds = Array.isArray(input.affectedSessionIds)
    ? input.affectedSessionIds.filter((item): item is string => typeof item === "string")
    : [];

  try {
    const { requestId } = await context.params;
    const detail = await createWiseCancelPreview(getDb(), requestId, {
      affectedSessionIds,
      actorEmail: session.user.email,
      actorName: session.user.name,
    });
    return NextResponse.json({ ok: true, detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wise cancel preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
