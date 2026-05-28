import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { updateLineMessageClassificationFeedback } from "@/lib/line/data";

const feedbackSchema = z.object({
  reviewedCategory: z.enum(["scheduling_request", "scheduling_change", "non_scheduling", "unclear"]),
}).strict();

type RouteContext = { params: Promise<{ messageId: string }> };

function actorFromSession(session: { user?: { email?: string | null; name?: string | null } } | null) {
  return {
    email: session?.user?.email ?? null,
    name: session?.user?.name ?? null,
  };
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
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
  const feedback = await updateLineMessageClassificationFeedback(getDb(), {
    messageId,
    reviewedCategory: parsed.data.reviewedCategory,
    actor: actorFromSession(session),
  });
  if (!feedback) {
    return NextResponse.json({ error: "LINE message not found" }, { status: 404 });
  }

  return NextResponse.json({ feedback });
}
