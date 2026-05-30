import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  listLineLinkValidationTasks,
  type LineLinkValidationScope,
} from "@/lib/line/link-validation";

const scopeSchema = z.enum(["my", "all", "unassigned", "verified", "rejected"]);
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

  const scopeParam = request.nextUrl.searchParams.get("scope") ?? "my";
  const scope = scopeSchema.safeParse(scopeParam);
  if (!scope.success) {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  const runIdParam = request.nextUrl.searchParams.get("runId") ?? undefined;
  const runId = runIdSchema.safeParse(runIdParam);
  if (!runId.success) {
    return NextResponse.json({ error: "Invalid runId" }, { status: 400 });
  }

  const result = await listLineLinkValidationTasks(getDb(), {
    scope: scope.data as LineLinkValidationScope,
    runId: runId.data,
    actor: actorFromSession(session),
  });
  return NextResponse.json(result);
}
