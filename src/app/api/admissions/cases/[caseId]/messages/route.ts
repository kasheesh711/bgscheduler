import { NextResponse } from "next/server";
import { z } from "zod";

import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import { sendCaseDirectMessage } from "@/lib/admissions/communications";

const ROUTE = "/api/admissions/cases/[caseId]/messages";
const schema = z.object({
  recipientMemberId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
}).strict();
type Context = { params: Promise<{ caseId: string }> };

export async function POST(request: Request, ctx: Context) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    const result = await sendCaseDirectMessage({
      access,
      senderName: user.name,
      ...parsed.data,
    });
    return NextResponse.json({
      sent: result.deliveryStatus === "sent",
      queued: result.deliveryStatus === "queued",
      superseded: result.deliveryStatus === "superseded",
      messageId: result.providerMessageId,
      outboxId: result.outboxId,
      idempotentReplay: result.idempotentReplay,
    });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Direct message failed");
  }
}
