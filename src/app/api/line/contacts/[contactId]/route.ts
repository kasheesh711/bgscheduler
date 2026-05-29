import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { updateLineContactLabels } from "@/lib/line/data";
import { ensureLineContactStudentLinkSuggestions, listLineContactStudentLinks } from "@/lib/line/student-links";

const patchContactSchema = z.object({
  linkedParentLabel: z.string().trim().max(200).nullable().optional(),
  linkedStudentLabel: z.string().trim().max(500).nullable().optional(),
}).strict();

type RouteContext = { params: Promise<{ contactId: string }> };

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

  const parsed = patchContactSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { contactId } = await ctx.params;
  const db = getDb();
  await updateLineContactLabels(db, contactId, parsed.data);
  await ensureLineContactStudentLinkSuggestions(db, contactId, parsed.data.linkedStudentLabel);
  const links = await listLineContactStudentLinks(db, contactId);
  return NextResponse.json({ links });
}
