import { after, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { submitPaperCheck } from "@/lib/hiring/marking";
import { deliverNow } from "@/lib/hiring/paper-check";

const body = z.object({
  updatedAt: z.iso.datetime({ offset: true }),
  marks: z.record(z.string().max(60), z.number().min(0).max(1000)),
  comment: z.string().trim().max(4000),
  // A head's pass of a near miss, with the reason (Kevin, 25 Nov 2026).
  override: z.string().trim().max(2000).optional(),
}).strict();

/**
 * Public: the head's link is the only access check. It saves the head's marks. A fail queues the rejection email.
 * Reachability needs the `/api/hiring/paper-check/{token}` entry in src/proxy.ts.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    requireSameOrigin(request);
    const input = body.parse(await request.json().catch(() => null));
    const db = getDb();
    const { outcome, outboxKey } = await submitPaperCheck((await context.params).token, input, db);
    after(() => deliverNow(db, outboxKey));
    return NextResponse.json({ ok: true, outcome }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return hiringError(error);
  }
}
