import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLineOaResolverRun } from "@/lib/line/oa-resolver";

type RouteContext = { params: Promise<{ runId: string }> };

export async function GET(_request: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await ctx.params;
  const run = await getLineOaResolverRun(getDb(), runId);
  if (!run) {
    return NextResponse.json({ error: "Resolver run not found" }, { status: 404 });
  }

  return NextResponse.json({ run });
}
