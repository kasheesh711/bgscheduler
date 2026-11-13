import { NextResponse } from "next/server";
import { z } from "zod";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { ITEM_MAX, RUBRIC_ITEMS, type MockRubric } from "@/lib/hiring/marking-sheet";
import { saveBriefRubric } from "@/lib/hiring/service";

const body = z
  .object({
    items: z.object(Object.fromEntries(RUBRIC_ITEMS.map((id) => [id, z.int().min(1).max(ITEM_MAX)]))).strict(),
    comments: z.string().trim().max(4000),
  })
  .strict();

/**
 * Public: the interviewer's link is the only access check. It saves that interviewer's scores for one mock.
 * Reachability needs the `/api/hiring/brief/{token}/rubric` entry in src/proxy.ts.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    requireSameOrigin(request);
    const rubric = body.parse(await request.json()) as MockRubric;
    return NextResponse.json({ total: await saveBriefRubric((await context.params).token, rubric) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return hiringError(error);
  }
}
