import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  listLineLinkValidationTasks,
  LINE_LINK_VALIDATION_SCOPES,
  type LineLinkValidationScope,
} from "@/lib/line/link-validation";

const scopeSchema = z.enum(LINE_LINK_VALIDATION_SCOPES);
const runIdSchema = z.string().uuid().optional();
const pageSchema = z.coerce.number().int().min(1).default(1);
const pageSizeSchema = z.coerce.number().int().min(1).max(100).default(100);

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

  const page = pageSchema.safeParse(request.nextUrl.searchParams.get("page") ?? undefined);
  if (!page.success) {
    return NextResponse.json({ error: "Invalid page" }, { status: 400 });
  }

  const pageSize = pageSizeSchema.safeParse(request.nextUrl.searchParams.get("pageSize") ?? undefined);
  if (!pageSize.success) {
    return NextResponse.json({ error: "Invalid pageSize" }, { status: 400 });
  }

  const result = await listLineLinkValidationTasks(getDb(), {
    scope: scope.data as LineLinkValidationScope,
    runId: runId.data,
    actor: actorFromSession(session),
    page: page.data,
    pageSize: pageSize.data,
  });
  return NextResponse.json(result);
}
