import { and, desc, eq, gt, inArray, isNotNull, isNull, like, ne } from "drizzle-orm";
import { type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { hireBlockers } from "./assessment-view";
import { HiringError, runtimeWritesAllowed, type HiringConfig } from "./model";
import { audit, candidateById, endVisit, enqueue, settings } from "./service";

export type Decision = "hire" | "reject";
const d = s.hiringDecisions;
const STAGE = { hire: "hired", reject: "rejected" } as const;

/** The first text in the preview. A person reads and edits it, and nothing leaves without their Send. */
export function resultEmail(decision: Decision, name: string, subject: string | null) {
  const what = subject ? `the ${subject} tutor position` : "the tutor position";
  if (decision === "hire")
    return {
      subject: "Your BeGifted tutor application: good news",
      body: `Dear ${name},\n\nThank you for visiting BeGifted for your assessment. We are pleased to offer you ${what}.\n\nOur team will contact you soon with the next steps. If you have a question, reply to this email.\n\nBeGifted Education`,
    };
  return {
    subject: "Your BeGifted tutor application",
    body: `Dear ${name},\n\nThank you for your interest in ${what} at BeGifted, and for the time you gave to your application. After careful review, we will not continue with your application at this time.\n\nWe wish you every success.\n\nBeGifted Education`,
  };
}

/** Why a result email cannot leave yet, in words for the screen. Both switches, as Kevin set them to stay off for now. */
export function sendRefusal(config: Pick<HiringConfig, "enabled" | "deliveryEnabled">) {
  if (!config.enabled || !config.deliveryEnabled) return "Automation and Messages must both be on before a result email can leave. The draft stays saved.";
  if (!runtimeWritesAllowed()) return "Result emails leave only from production. The draft stays saved.";
  return null;
}

async function resultsOf(tx: Database, candidateId: string) {
  const [papers, mocks] = await Promise.all([
    tx.select().from(s.hiringPaperResults).where(eq(s.hiringPaperResults.candidateId, candidateId)),
    tx.select().from(s.hiringMockResults).where(eq(s.hiringMockResults.candidateId, candidateId)),
  ]);
  return { papers, mocks };
}

async function assertAllowed(tx: Database, candidate: Awaited<ReturnType<typeof candidateById>>, decision: Decision, reason: string) {
  if (!candidate.email) throw new HiringError(409, "This candidate has no email address, so a result email cannot go. Use Stop in the full record.");
  if (decision === "reject" && reason.trim().length < 5) throw new HiringError(400, "Write a reason of at least 5 characters.");
  if (decision === "hire") {
    const { papers, mocks } = await resultsOf(tx, candidate.id);
    const blockers = hireBlockers(papers, mocks);
    if (blockers.length) throw new HiringError(409, blockers.join(" "));
  }
  // Only a visit: an old-flow booking has no Cancel action, so Send ends it instead of stranding the candidate.
  const [ahead] = await tx
    .select({ id: s.hiringBookings.id })
    .from(s.hiringBookings)
    .where(and(eq(s.hiringBookings.candidateId, candidate.id), eq(s.hiringBookings.status, "confirmed"), isNotNull(s.hiringBookings.visitId), gt(s.hiringBookings.endTime, new Date())))
    .limit(1);
  if (ahead) throw new HiringError(409, "This candidate has a visit ahead. Cancel the visit first.");
  // A stale tab must not send the same result twice. A send that failed can go again.
  const [standing] = await tx.select().from(d).where(and(eq(d.candidateId, candidate.id), eq(d.status, "sent"), eq(d.decision, decision))).limit(1);
  if (standing?.outboxKey) {
    const [row] = await tx.select({ status: s.hiringOutbox.status }).from(s.hiringOutbox).where(eq(s.hiringOutbox.key, standing.outboxKey));
    if (row && ["sent", "pending", "processing"].includes(row.status)) throw new HiringError(409, `This ${decision === "hire" ? "Hire" : "Reject"} email was already sent or is on its way.`);
  }
}

/** Saves a draft with the email text. It changes no stage and creates no outbox row, so nothing can leave later by itself. */
export async function draftDecision(candidateId: string, input: { decision: Decision; reason: string }, actor: string, db: Database) {
  return withDatabaseTransaction(db, async (tx) => {
    await tx.select({ id: s.hiringCandidates.id }).from(s.hiringCandidates).where(eq(s.hiringCandidates.id, candidateId)).for("update");
    const candidate = await candidateById(tx, candidateId);
    await assertAllowed(tx, candidate, input.decision, input.reason);
    await tx.update(d).set({ status: "replaced" }).where(and(eq(d.candidateId, candidateId), eq(d.status, "draft")));
    const email = resultEmail(input.decision, candidate.name, candidate.visitSubject ?? candidate.subjects[0] ?? null);
    const [draft] = await tx
      .insert(d)
      .values({ candidateId, decision: input.decision, reason: input.reason.trim(), emailSubject: email.subject, emailBody: email.body, decidedBy: actor })
      .returning();
    await audit(tx, actor, "decision-draft", candidateId, { decision: input.decision, reason: input.reason.trim() });
    return draft;
  });
}

/** Keeps a person's edits while the switches are off or they stop for now. Nothing leaves until Send. */
export async function saveDraft(id: string, input: { emailSubject: string; emailBody: string }, actor: string, db: Database) {
  const [row] = await db
    .update(d)
    .set({ emailSubject: input.emailSubject.trim(), emailBody: input.emailBody.trim() })
    .where(and(eq(d.id, id), eq(d.status, "draft")))
    .returning();
  if (!row) throw new HiringError(409, "This draft has changed. Refresh the page.");
  await audit(db, actor, "decision-draft-edit", row.candidateId, { decision: row.decision });
}

export async function discardDecision(id: string, actor: string, db: Database) {
  const [row] = await db.update(d).set({ status: "replaced" }).where(and(eq(d.id, id), eq(d.status, "draft"))).returning();
  if (!row) throw new HiringError(409, "This draft has changed. Refresh the page.");
  await audit(db, actor, "decision-discard", row.candidateId, { decision: row.decision });
}

/**
 * The only way a result email leaves. One candidate, one click. It checks the rules again, moves the stage and queues the
 * row in one transaction, so a double click stops at the draft's status. The caller delivers this one row right after.
 */
export async function sendDecision(id: string, input: { emailSubject: string; emailBody: string }, actor: string, db: Database, now = new Date()) {
  const emailSubject = input.emailSubject.trim();
  const emailBody = input.emailBody.trim();
  if (!emailSubject || !emailBody) throw new HiringError(400, "Write a subject and a message.");
  const key = await withDatabaseTransaction(db, async (tx) => {
    const { config } = await settings(tx);
    const refusal = sendRefusal(config);
    if (refusal) throw new HiringError(409, refusal);
    // Candidate first, then draft, the same order as drafting, so the two cannot deadlock.
    const [known] = await tx.select({ candidateId: d.candidateId }).from(d).where(eq(d.id, id));
    if (!known) throw new HiringError(409, "This draft was already sent or replaced. Refresh the page.");
    await tx.select({ id: s.hiringCandidates.id }).from(s.hiringCandidates).where(eq(s.hiringCandidates.id, known.candidateId)).for("update");
    const [draft] = await tx.select().from(d).where(eq(d.id, id)).for("update");
    if (!draft || draft.status !== "draft") throw new HiringError(409, "This draft was already sent or replaced. Refresh the page.");
    const candidate = await candidateById(tx, draft.candidateId);
    await assertAllowed(tx, candidate, draft.decision, draft.reason);
    const stage = STAGE[draft.decision];
    const outboxKey = `${candidate.id}:result:${draft.id}`;
    // An earlier result email that has not left must not follow this one. A row in the worker's hands may be leaving.
    const earlier = await tx
      .select({ status: s.hiringOutbox.status })
      .from(s.hiringOutbox)
      .where(and(eq(s.hiringOutbox.candidateId, candidate.id), like(s.hiringOutbox.key, `${candidate.id}:result:%`)));
    if (earlier.some((row) => row.status === "processing")) throw new HiringError(409, "An earlier result email is being sent right now. Wait a minute and check it first.");
    await tx
      .update(s.hiringOutbox)
      .set({ status: "cancelled" })
      .where(and(eq(s.hiringOutbox.candidateId, candidate.id), like(s.hiringOutbox.key, `${candidate.id}:result:%`), inArray(s.hiringOutbox.status, ["pending", "failed", "uncertain"])));
    // The person is decided, so an old-flow booking still ahead must leave the head's calendar.
    const oldFlowAhead = await tx
      .select()
      .from(s.hiringBookings)
      .where(and(eq(s.hiringBookings.candidateId, candidate.id), eq(s.hiringBookings.status, "confirmed"), isNull(s.hiringBookings.visitId), gt(s.hiringBookings.endTime, now)));
    if (oldFlowAhead.length) await endVisit(tx, oldFlowAhead, "cancelled", now);
    const queued = await enqueue(tx, {
      key: outboxKey,
      candidateId: candidate.id,
      kind: "email",
      createdAt: now,
      // A later change of decision moves the stage, and delivery then cancels this row if it has not left.
      payload: { to: candidate.email!, subject: emailSubject, text: emailBody, workflowStage: stage },
    });
    if (!queued) throw new HiringError(409, "This email was already queued.");
    await tx
      .update(s.hiringCandidates)
      .set({ stage, inviteExpiresAt: null, revision: candidate.revision + 1, updatedAt: now })
      .where(eq(s.hiringCandidates.id, candidate.id));
    // Only one decision stands. The earlier email is not recalled.
    await tx.update(d).set({ status: "replaced" }).where(and(eq(d.candidateId, candidate.id), eq(d.status, "sent"), ne(d.id, id)));
    await tx.update(d).set({ status: "sent", emailSubject, emailBody, outboxKey, sentAt: now }).where(eq(d.id, id));
    await audit(tx, actor, "decision-send", candidate.id, { decision: draft.decision, stage, outboxKey });
    return outboxKey;
  });
  return key;
}

export const latestDecision = (db: Database, candidateId: string) =>
  db.select().from(d).where(eq(d.candidateId, candidateId)).orderBy(desc(d.createdAt)).limit(1);
