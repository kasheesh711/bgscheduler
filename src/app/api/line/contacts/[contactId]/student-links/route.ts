import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  createVerifiedLineContactStudentLink,
  ensureLineContactStudentLinkSuggestions,
  listLineContactStudentLinks,
  patchLineContactStudentLinkStatus,
} from "@/lib/line/student-links";

const postSchema = z.object({
  studentKey: z.string().trim().min(1).max(240),
}).strict();

const patchSchema = z.object({
  action: z.enum(["verify", "reject"]),
  linkId: z.string().uuid(),
}).strict();

type RouteContext = { params: Promise<{ contactId: string }> };

function actorFromSession(session: { user?: { email?: string | null; name?: string | null } } | null) {
  return {
    email: session?.user?.email ?? null,
    name: session?.user?.name ?? null,
  };
}

export async function GET(_request: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { contactId } = await ctx.params;
  const db = getDb();
  const links = await ensureLineContactStudentLinkSuggestions(db, contactId);
  return NextResponse.json({ links });
}

export async function POST(request: NextRequest, ctx: RouteContext) {
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

  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { contactId } = await ctx.params;
  const db = getDb();
  const link = await createVerifiedLineContactStudentLink(db, {
    contactId,
    studentKey: parsed.data.studentKey,
    actor: actorFromSession(session),
  });
  if (!link) {
    return NextResponse.json({ error: "Current credit-control student not found" }, { status: 404 });
  }

  const links = await listLineContactStudentLinks(db, contactId);
  return NextResponse.json({ link, links }, { status: 201 });
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { contactId } = await ctx.params;
  const db = getDb();
  const link = await patchLineContactStudentLinkStatus(db, {
    contactId,
    linkId: parsed.data.linkId,
    status: parsed.data.action === "verify" ? "verified" : "rejected",
    actor: actorFromSession(session),
  });
  if (!link) {
    return NextResponse.json({ error: "Student link not found" }, { status: 404 });
  }

  const links = await listLineContactStudentLinks(db, contactId);
  return NextResponse.json({ link, links });
}
