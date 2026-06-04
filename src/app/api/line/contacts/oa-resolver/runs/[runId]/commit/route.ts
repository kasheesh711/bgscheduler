import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commitLineOaResolverRun } from "@/lib/line/oa-resolver";

const commitSchema = z.object({
  rowIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
  selectedCandidates: z.array(z.object({
    rowId: z.string().uuid(),
    lineUserId: z.string().regex(/^U[a-fA-F0-9]{32}$/u),
  }).strict()).max(5000).optional(),
}).strict();

type RouteContext = { params: Promise<{ runId: string }> };

export async function POST(request: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = commitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { runId } = await ctx.params;
  const result = await commitLineOaResolverRun(getDb(), {
    runId,
    rowIds: parsed.data.rowIds,
    selectedCandidates: parsed.data.selectedCandidates,
  });
  if (!result) {
    return NextResponse.json({ error: "Resolver run not found" }, { status: 404 });
  }

  return NextResponse.json({ result });
}
