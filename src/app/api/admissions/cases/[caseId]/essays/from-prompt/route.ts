import { NextResponse } from "next/server";
import { z } from "zod";

import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import { createEssayFromCatalogPrompt } from "@/lib/admissions/essay-prompt-catalog";
import { roleAtLeast } from "@/lib/admissions/config";

const ROUTE = "/api/admissions/cases/[caseId]/essays/from-prompt";
const schema = z.object({
  promptId: z.string().uuid(),
  listItemId: z.string().uuid().nullish(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
type Context = { params: Promise<{ caseId: string }> };

export async function POST(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "student");
    assertCaseMutationAllowed(access);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    if (
      !roleAtLeast(access.role, "counselor") &&
      (parsed.data.listItemId !== undefined || parsed.data.deadline !== undefined)
    ) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ essay: await createEssayFromCatalogPrompt({ access, ...parsed.data }) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Essay prompt selection failed");
  }
}
