import { after, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { saveBriefDecision } from "@/lib/hiring/decisions";
import { settings } from "@/lib/hiring/service";
import { deliverOutbox } from "@/lib/hiring/worker";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";

const body = z.object({ decision: z.enum(["hire", "reject"]), reason: z.string().trim().max(1000) }).strict();

/**
 * Public: the interviewer's link is the only access check. It records the tutor’s recommendation. A No queues a rejection email.
 * Reachability needs the `/api/hiring/brief/{token}/decision` entry in src/proxy.ts.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    requireSameOrigin(request);
    const input = body.parse(await request.json().catch(() => null));
    const db = getDb();
    const { queued } = await saveBriefDecision((await context.params).token, input, db);
    if (queued) after(async () => {
      const { config } = await settings(db);
      await deliverOutbox(db, config, 1, false, queued);
    });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return hiringError(error);
  }
}
