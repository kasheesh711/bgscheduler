import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { patchLineLinkValidationTaskStatus } from "@/lib/line/link-validation";

const patchSchema = z.object({
  status: z.enum(["verified", "rejected"]),
  note: z.string().trim().max(1000).nullable().optional(),
}).strict();

type RouteContext = { params: Promise<{ linkId: string }> };

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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { linkId } = await ctx.params;
  const task = await patchLineLinkValidationTaskStatus(getDb(), {
    linkId,
    status: parsed.data.status,
    note: parsed.data.note,
    actor: actorFromSession(session),
  });
  if (!task) {
    return NextResponse.json({ error: "Student link not found" }, { status: 404 });
  }

  return NextResponse.json({ task });
}
