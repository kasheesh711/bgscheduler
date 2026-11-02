import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { markPaper, readMockRubric } from "@/lib/hiring/marking";

// A scanned paper can take minutes. The model call has its own shorter limit, so a result always gets saved.
export const maxDuration = 300;
const body = z.object({ kind: z.enum(["paper", "mock"]), id: z.uuid() }).strict();

export async function POST(request: Request) {
  try {
    const actor = await requireHiringAdmin();
    requireSameOrigin(request);
    const input = body.parse(await request.json());
    return NextResponse.json(await (input.kind === "paper" ? markPaper : readMockRubric)(input.id, actor, getDb()));
  } catch (error) {
    return hiringError(error);
  }
}
