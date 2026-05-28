import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { promoteLineMessageToReview } from "@/lib/line/review-service";

type RouteContext = { params: Promise<{ messageId: string }> };

function actorFromSession(session: { user?: { email?: string | null; name?: string | null } } | null) {
  return {
    email: session?.user?.email ?? null,
    name: session?.user?.name ?? null,
  };
}

export async function POST(_request: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { messageId } = await ctx.params;
  const { review, alreadyExisted } = await promoteLineMessageToReview({
    db: getDb(),
    lineMessageId: messageId,
    actor: actorFromSession(session),
  });
  if (!review) {
    return NextResponse.json({ error: "LINE message not found" }, { status: 404 });
  }

  return NextResponse.json({ review, alreadyExisted });
}
