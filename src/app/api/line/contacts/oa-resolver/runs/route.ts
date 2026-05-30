import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  createLineOaResolverRun,
  getLatestLineOaResolverRun,
  listLineOaResolverRuns,
} from "@/lib/line/oa-resolver";

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

  const latest = request.nextUrl.searchParams.get("latest") === "true";
  if (!latest) {
    const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(limitParam) ? limitParam : 20;
    const runs = await listLineOaResolverRuns(getDb(), limit);
    return NextResponse.json({ runs });
  }

  const run = await getLatestLineOaResolverRun(getDb(), actorFromSession(session));
  return NextResponse.json({ run });
}

export async function POST() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await createLineOaResolverRun(getDb(), actorFromSession(session));
  return NextResponse.json(result, { status: 201 });
}
