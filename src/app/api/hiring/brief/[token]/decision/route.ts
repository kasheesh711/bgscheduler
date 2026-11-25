import { after, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { finalReviewerKey, requireHiringAdmin } from "@/lib/hiring/access";
import { saveBriefDecision } from "@/lib/hiring/decisions";
import { finalReviewAccess } from "@/lib/hiring/final-review";
import { HiringError } from "@/lib/hiring/model";
import { OFFER_TYPES } from "@/lib/hiring/offer-letters";
import { settings } from "@/lib/hiring/service";
import { deliverOutbox } from "@/lib/hiring/worker";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";

const body = z.object({ decision: z.enum(["hire", "reject"]), reason: z.string().trim().max(1000), offerType: z.enum(OFFER_TYPES).optional() }).strict();

/**
 * Public: the interviewer's link is the only access check. It records the tutor’s recommendation. A No queues a rejection email.
 * With `offerType` it is Gift's Hire on her own mock: that also needs her sign-in, and it emails the offer at once.
 * Reachability needs the `/api/hiring/brief/{token}/decision` entry in src/proxy.ts.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    requireSameOrigin(request);
    const { offerType, ...input } = body.parse(await request.json().catch(() => null));
    const db = getDb();
    // Any Hire needs Gift's head key: on her own mock only the offer path is open.
    const key = input.decision === "hire" ? await finalReviewerKey(db) : null;
    let offer;
    if (offerType) {
      const actor = await requireHiringAdmin();
      if (!finalReviewAccess(actor).gift) throw new HiringError(403, "Gift’s sign-in is required to send an offer.");
      if (!key) throw new HiringError(503, "Gift’s head record could not be checked. Try again in a minute.");
      offer = { actor, offerType };
    }
    const { queued } = await saveBriefDecision((await context.params).token, input, db, new Date(), { key, offer });
    if (queued) after(async () => {
      const { config } = await settings(db);
      await deliverOutbox(db, config, 1, false, queued);
    });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return hiringError(error);
  }
}
