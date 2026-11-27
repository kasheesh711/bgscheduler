import { after, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { hiringCandidates, hiringOutbox } from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { auth } from "@/lib/auth";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { currentFunnel } from "@/lib/hiring/current-funnel";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { HiringError, runtimeWritesAllowed, subjectSchema } from "@/lib/hiring/model";
import { audit, HiringEmailPreview, reviewCandidate, settings } from "@/lib/hiring/service";
import { deliverOutbox } from "@/lib/hiring/worker";

const base = z.object({ id: z.uuid(), revision: z.number().int().nonnegative() });
const command = z.discriminatedUnion("action", [
  base.extend({
    action: z.literal("follow_up"),
    outcome: z.enum(["Reached", "No answer", "Call back"]),
    note: z.string().trim().max(1000),
    followUp: z.iso.date().optional(),
  }),
  base.extend({
    action: z.enum(["paper_pass", "advance", "invite_onsite", "waive_paper", "cancel_funnel_visit"]),
    subjects: z.array(subjectSchema),
    visitBookingIds: z.array(z.uuid()),
    reason: z.string().trim().min(5).max(2000),
    preview: z.boolean(),
    expectedRecipient: z.email().optional(),
  }),
]);
export async function GET(request: Request) {
  try {
    await requireHiringAdmin();
    const receipt = new URL(request.url).searchParams.get("receipt");
    if (receipt) {
      const [message] = await getDb()
        .select({ status: hiringOutbox.status })
        .from(hiringOutbox)
        .where(eq(hiringOutbox.key, receipt));
      if (!message) throw new HiringError(404, "Email record unavailable.");
      return NextResponse.json({ status: message.status }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(await currentFunnel(getDb()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return hiringError(error);
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await requireHiringAdmin();
    const input = command.parse(await request.json());
    if (!runtimeWritesAllowed())
      throw new HiringError(403, "Hiring changes are unavailable in this environment.");
    const db = getDb();
    if (input.action === "follow_up") {
      await withDatabaseTransaction(db, async (tx) => {
        const [p] = await tx
          .select()
          .from(hiringCandidates)
          .where(eq(hiringCandidates.id, input.id))
          .for("update");
        if (!p || p.revision !== input.revision)
          throw new HiringError(409, "This candidate changed. Refresh the queue.");
        await audit(tx, actor, "funnel-call", p.id, {
          outcome: input.outcome,
          note: input.note,
          followUp: input.followUp,
        });
        await tx
          .update(hiringCandidates)
          .set({ revision: p.revision + 1 })
          .where(eq(hiringCandidates.id, p.id));
      });
      return NextResponse.json({ ok: true });
    }
    if (input.action === "waive_paper" && (await auth())?.user?.allowedPages !== null)
      throw new HiringError(403, "Only full Hiring administrators can waive a paper assessment.");
    const key = await reviewCandidate(input.id, { ...input, funnel: true }, actor, db);
    if (key)
      after(async () => {
        const { config } = await settings(db);
        await deliverOutbox(db, config, 1, false, key);
      });
    return NextResponse.json({ ok: true, status: "queued", receipt: key });
  } catch (error) {
    if (error instanceof HiringEmailPreview)
      return NextResponse.json(
        { preview: error.messagePreview },
        { headers: { "Cache-Control": "no-store" } },
      );
    return hiringError(error);
  }
}
