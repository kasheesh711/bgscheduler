import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLineReviewChatContext } from "@/lib/line/data";

type RouteContext = { params: Promise<{ reviewId: string }> };

export async function GET(_request: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { reviewId } = await ctx.params;
  const context = await getLineReviewChatContext(getDb(), reviewId);
  if (!context) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }

  return NextResponse.json({ context });
}
