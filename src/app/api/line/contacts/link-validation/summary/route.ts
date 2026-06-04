import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLineLinkValidationSummary } from "@/lib/line/link-validation";

const runIdSchema = z.string().uuid().optional();

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

  const runIdParam = request.nextUrl.searchParams.get("runId") ?? undefined;
  const runId = runIdSchema.safeParse(runIdParam);
  if (!runId.success) {
    return NextResponse.json({ error: "Invalid runId" }, { status: 400 });
  }

  const summary = await getLineLinkValidationSummary(getDb(), {
    runId: runId.data,
    actor: actorFromSession(session),
  });
  return NextResponse.json({ summary });
}
