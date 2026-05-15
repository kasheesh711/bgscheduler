import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  patchProposalItem,
  ProposalNotFoundError,
  ProposalValidationError,
} from "@/lib/proposals/data";

const patchSchema = z.object({
  action: z.enum(["confirm", "release", "extend"]),
});

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ itemId: string }> },
) {
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

  const { itemId } = await ctx.params;

  try {
    const holds = await patchProposalItem(
      getDb(),
      itemId,
      parsed.data.action,
      {
        email: session.user?.email,
        name: session.user?.name,
      },
    );
    return NextResponse.json({ holds });
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ProposalValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Failed to update proposal";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
