import "server-only";
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { ScheduleEmailRejection, type ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import { withPostClassTransaction } from "./transaction";
import { listCaptures } from "./captures";
import { buildDeductionReport, DEDUCTION_REPORT_RECIPIENTS, previousReportDay, reportDeliveryCanSend, type DeductionReportRow } from "./deduction-report-model";

const runs = schema.postClassNotificationRuns, deliveries = schema.postClassNotificationDeliveries, attempts = schema.postClassNotificationAttempts;
const dateLabel = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(at);

export async function loadDeductionReport(now = new Date(), db: Database = getDb()) {
  const period = previousReportDay(now);
  const candidates = await db.select({ deduction: schema.postClassDeductions, session: schema.postClassSessions, createdAt: schema.postClassDeductionActions.occurredAt })
    .from(schema.postClassDeductionActions).innerJoin(schema.postClassDeductions, eq(schema.postClassDeductions.id, schema.postClassDeductionActions.deductionId))
    .innerJoin(schema.postClassSessions, eq(schema.postClassSessions.id, schema.postClassDeductions.sessionId))
    .where(and(eq(schema.postClassDeductionActions.action, "candidate_created"), gte(schema.postClassDeductionActions.occurredAt, period.start), lt(schema.postClassDeductionActions.occurredAt, period.end)))
    .orderBy(asc(schema.postClassSessions.canonicalTutorName), asc(schema.postClassSessions.scheduledStartAt));
  const limits: string[] = [];
  const [sync] = await db.select().from(schema.postClassSyncRuns).where(eq(schema.postClassSyncRuns.status, "success")).orderBy(desc(schema.postClassSyncRuns.finishedAt)).limit(1);
  if (!sync?.finishedAt || now.getTime() - sync.finishedAt.getTime() > 60 * 60_000) limits.push("Wise feedback collection has no successful result in the last hour");
  const issues = await db.select({ id: schema.postClassSourceIssues.id }).from(schema.postClassSourceIssues)
    .where(and(eq(schema.postClassSourceIssues.status, "open"), eq(schema.postClassSourceIssues.blocksEnforcement, true)));
  if (issues.length) limits.push(`${issues.length} source issues require review`);
  const rows = await Promise.all(candidates.map(async ({ deduction, session, createdAt }): Promise<DeductionReportRow> => {
    const [evidence, [assessment], payoutLines] = await Promise.all([
      listCaptures(session.id, db),
      db.select().from(schema.postClassAssessments).where(and(eq(schema.postClassAssessments.sessionId, session.id), lte(schema.postClassAssessments.assessedAt, createdAt))).orderBy(desc(schema.postClassAssessments.assessedAt)).limit(1),
      db.select().from(schema.postClassPayoutRunLines).where(eq(schema.postClassPayoutRunLines.deductionId, deduction.id)).orderBy(desc(schema.postClassPayoutRunLines.createdAt)),
    ]);
    const matching = evidence.captures.filter(row => row.currentDeadline && row.currentClass && row.mode === "deadline");
    const payout = payoutLines[0];
    const screenshot = [
      ...(!matching.some(row => row.uploadStatus === "ready" && row.state !== "uncheckable") ? ["Missing verified deadline evidence"] : []),
      ...evidence.captures.map(row => `${row.state}; ${row.timing.replaceAll("_", " ")}; ${row.uploadStatus}; observed ${dateLabel(row.observedAt)}; captured ${dateLabel(row.capturedAt)}${row.conflict ? "; STAFF EVENT CONFLICT" : ""}${row.duringCapture ? "; STAFF FEEDBACK SUBMITTED DURING CAPTURE" : ""}${!row.currentClass ? "; CLASS IDENTITY CHANGED" : ""}${!row.currentDeadline ? "; DEADLINE CHANGED" : ""}`),
    ].join(" | ");
    if (session.sourceStatus !== "ready") limits.push(`${session.canonicalTutorName ?? "Tutor"}: class source needs review`);
    return { sessionId: session.id, tutor: session.canonicalTutorName ?? "Tutor identity needs review", students: evidence.binding.students.join(", "), subject: evidence.binding.subject,
      classTime: `${dateLabel(session.scheduledStartAt)}–${dateLabel(session.scheduledEndAt)}`, deadline: dateLabel(session.deadlineAt),
      reason: `${(assessment?.timingStatus ?? session.timingStatus) === "late" ? "Late or missing feedback" : "Feedback content does not meet the policy"}${assessment?.fieldFailures.length ? ` (${assessment.fieldFailures.join(", ")})` : ""}`,
      amountMinor: deduction.amountMinor, status: deduction.status,
      payout: payout ? `${payout.writeStatus}${payout.writtenAt ? ` at ${dateLabel(payout.writtenAt)}` : ""}` : "Not posted", screenshot };
  }));
  return buildDeductionReport(period.date, rows, [...new Set(limits)]);
}

async function reportRunCounts(runId: string, db: Database) {
  await withPostClassTransaction(db, async tx => {
  await tx.execute(sql`select id from ${runs} where ${runs.id} = ${runId} for update`);
  const rows = await tx.select().from(deliveries).where(eq(deliveries.runId, runId));
  const sentCount = rows.filter(row => row.status === "sent").length;
  const failedCount = rows.filter(row => row.status === "failed" || row.status === "unknown").length;
  const status = rows.some(row => row.status === "unknown") ? "unknown" : sentCount === rows.length && rows.length > 0 ? "sent" : failedCount ? "failed" : "pending";
  await tx.update(runs).set({ status, sentCount, failedCount, finishedAt: status === "sent" ? new Date() : null, updatedAt: new Date() }).where(eq(runs.id, runId));
  });
}
export async function attemptDeductionReportDelivery(deliveryId: string, db: Database = getDb(), sender: ScheduleEmailSender = createOutboundEmailSender("primary", { strictOutcome: true, audience: "staff" }), now = new Date()): Promise<"sent" | "failed" | "skipped"> {
  const [loaded] = await db.select({ delivery: deliveries, run: runs }).from(deliveries).innerJoin(runs, eq(deliveries.runId, runs.id)).where(eq(deliveries.id, deliveryId));
  if (!loaded || loaded.run.kind !== "deduction_report") return "skipped";
  const row = loaded.delivery;
  if (row.status === "sending" && now.getTime() - row.updatedAt.getTime() > 20 * 60_000) {
    await db.update(deliveries).set({ status: "unknown", nextAttemptAt: null, finalError: "Acceptance is uncertain. Inspect the sender before any retry.", updatedAt: now })
      .where(and(eq(deliveries.id, row.id), eq(deliveries.status, "sending"), eq(deliveries.attemptCount, row.attemptCount)));
    await reportRunCounts(row.runId, db);
    return "skipped";
  }
  if (!reportDeliveryCanSend(row.status) || row.attemptCount >= 4 || (row.nextAttemptAt && row.nextAttemptAt > now)) return "skipped";
  if (!DEDUCTION_REPORT_RECIPIENTS.some(email => email === row.recipientEmail)) return "skipped";
  const content = loaded.run.metadata;
  if (typeof content.text !== "string" || typeof content.html !== "string") throw new Error("Saved report content is unavailable.");
  const [claimed] = await db.update(deliveries).set({ status: "sending", attemptCount: row.attemptCount + 1, updatedAt: now }).where(and(eq(deliveries.id, row.id), eq(deliveries.status, row.status), eq(deliveries.attemptCount, row.attemptCount))).returning();
  if (!claimed) return "skipped";
  const [attempt] = await db.insert(attempts).values({ deliveryId, attemptNumber: claimed.attemptCount, provider: "primary", status: "sending", startedAt: now }).returning();
  let result: { id: string };
  try {
    result = await sender.sendEmail({ to: claimed.recipientEmail, subject: claimed.subject, text: content.text, html: content.html, idempotencyKey: claimed.idempotencyKey });
    if (!result.id?.trim()) throw new Error("Email acceptance has no receipt.");
  } catch (error) {
    const rejected = error instanceof ScheduleEmailRejection;
    const status = rejected ? "failed" : "unknown";
    await withPostClassTransaction(db, async tx => {
      await tx.update(attempts).set({ status, errorMessage: rejected ? "Email rejected before acceptance." : "Acceptance is uncertain. Inspect the sender before retry.", finishedAt: new Date() }).where(eq(attempts.id, attempt.id));
      await tx.update(deliveries).set({ status, nextAttemptAt: rejected && claimed.attemptCount < 4 ? new Date(now.getTime() + 30 * 60_000) : null,
        finalError: rejected ? "Email rejected before acceptance." : "Acceptance is uncertain. Inspect the sender before retry.", updatedAt: new Date() }).where(eq(deliveries.id, deliveryId));
    });
    await reportRunCounts(row.runId, db);
    return "failed";
  }
  // A persistence failure leaves 'sending'; it must never cause another send.
  await withPostClassTransaction(db, async tx => {
    await tx.update(attempts).set({ status: "sent", providerMessageId: result.id, finishedAt: new Date() }).where(eq(attempts.id, attempt.id));
    await tx.update(deliveries).set({ status: "sent", provider: "primary", providerMessageId: result.id, sentAt: new Date(), nextAttemptAt: null, finalError: null, updatedAt: new Date() }).where(eq(deliveries.id, deliveryId));
  });
  await reportRunCounts(row.runId, db);
  return "sent";
}
export async function sendDeductionReport(now = new Date(), db: Database = getDb(), sender?: ScheduleEmailSender) {
  const { date } = previousReportDay(now), key = `deduction-report:${date}`;
  const [prior] = await db.select().from(runs).where(eq(runs.idempotencyKey, key));
  const content = prior ? null : await loadDeductionReport(now, db);
  const run = await withPostClassTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [inserted] = content ? await tx.insert(runs).values({ kind: "deduction_report", scheduledFor: now, idempotencyKey: key, startedAt: now,
      metadata: { ...content.metadata, text: content.text, html: content.html }, eligibleCount: content.metadata.rows.length, deliveryCount: DEDUCTION_REPORT_RECIPIENTS.length })
      .onConflictDoNothing({ target: runs.idempotencyKey }).returning() : [];
    const [existing] = inserted ? [] : await tx.select().from(runs).where(eq(runs.idempotencyKey, key));
    const saved = inserted ?? existing;
    if (!saved) throw new Error("Report could not be saved.");
    for (const email of DEDUCTION_REPORT_RECIPIENTS) await tx.insert(deliveries).values({ runId: saved.id, recipientEmail: email,
      subject: `New feedback deductions — ${date}`, idempotencyKey: `${key}:${email}`,
      frozenContent: { text: String(saved.metadata.text), html: String(saved.metadata.html), sessionIds: content?.metadata.rows.map(row => row.sessionId) ?? [], frozenAt: saved.startedAt!.toISOString() } }).onConflictDoNothing({ target: deliveries.idempotencyKey });
    return saved;
  });
  const queued = await db.select({ id: deliveries.id }).from(deliveries).innerJoin(runs, eq(runs.id, deliveries.runId)).where(and(eq(runs.kind, "deduction_report"),
    or(eq(deliveries.runId, run.id), and(inArray(deliveries.status, ["failed", "sending"]), lte(deliveries.updatedAt, new Date(now.getTime() - 30 * 60_000))))));
  for (const row of queued) await attemptDeductionReportDelivery(row.id, db, sender, now);
  await reportRunCounts(run.id, db);
  const [saved] = await db.select().from(runs).where(eq(runs.id, run.id));
  return { runId: saved.id, date, status: saved.status, sent: saved.sentCount, failed: saved.failedCount, duplicate: Boolean(prior) };
}
