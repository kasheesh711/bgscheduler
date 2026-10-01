import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, notInArray, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { ScheduleEmailRejection, type ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import { buildFeedbackReminderEmail, feedbackReminderSubject } from "@/lib/teacher-emails/templates";
import { teacherEmailLogoUrl } from "@/lib/teacher-emails/brand";
import { teacherEmailPublicBaseUrl } from "@/lib/teacher-emails/config";
import { resolvePostClassTutorRecipient, safePostClassWiseSessionUrl } from "./notifications";
import { PostClassConflictError, PostClassValidationError } from "./errors";
import { withPostClassTransaction } from "./transaction";
import { createGmailSender, GmailRejection } from "./gmail";
import { feedbackGmailAccessToken } from "./gmail-credentials";
import { latestNightlyDate, nightlyCheckpoint, nightlyCounts, nightlyDisposition, nightlyWindow,
  NIGHTLY_FRESHNESS_MS, NIGHTLY_RETRY_MINUTES, NIGHTLY_TERMINAL, type NightlySessionState } from "./nightly-reminder-model";
import { discoverNightlyInventory, refreshNightlyItems, type NightlyInventory, type NightlyInventoryItem } from "./nightly-reminder-source";

const ledger = schema.postClassReminderLedger;
const deliveries = schema.postClassNotificationDeliveries;
const runs = schema.postClassNotificationRuns;
const attempts = schema.postClassNotificationAttempts;
const BUDGET_MS = 8 * 60_000;
const LEASE_MS = 15 * 60_000; // exceeds the route's 800-second hard limit
type LedgerRow = typeof ledger.$inferSelect;
type Session = typeof schema.postClassSessions.$inferSelect;
type Assessment = typeof schema.postClassAssessments.$inferSelect;
type LoadedState = { session: Session; assessment: Assessment | null; policyCurrent: boolean };

export interface NightlyReminderOptions {
  db?: Database;
  now?: Date;
  clock?: () => Date;
  discover?: (date: string) => Promise<NightlyInventory>;
  refresh?: (items: NightlyInventoryItem[], now: Date) => Promise<void>;
  senders?: { primary: ScheduleEmailSender; backup: ScheduleEmailSender };
  maxRefreshBatches?: number;
  /** Admin-only rehearsal of the most recent nightly window. Never sends. */
  shadowPreview?: boolean;
}

async function settings(db: Database) {
  const [value] = await db.select().from(schema.postClassSettings).limit(1);
  if (!value) throw new PostClassValidationError("Feedback settings are not initialized.");
  return value;
}

async function loadStates(db: Database, rows: LedgerRow[]): Promise<Map<string, LoadedState>> {
  if (!rows.length) return new Map();
  const result = new Map<string, LoadedState>();
  const config = await settings(db);
  const inventoryById = new Map(rows.map((row) => [row.wiseSessionId, row]));
  // Bounded IN lists also support a source larger than the old sheet's row limit.
  for (let start = 0; start < rows.length; start += 500) {
    const sessions = await db.select().from(schema.postClassSessions)
      .where(inArray(schema.postClassSessions.wiseSessionId, rows.slice(start, start + 500).map((row) => row.wiseSessionId)));
    const assessments = sessions.length ? await db.select().from(schema.postClassAssessments)
      .where(inArray(schema.postClassAssessments.sessionId, sessions.map((row) => row.id)))
      .orderBy(desc(schema.postClassAssessments.assessedAt), desc(schema.postClassAssessments.createdAt)) : [];
    const latest = new Map<string, Assessment>();
    for (const assessment of assessments) if (!latest.has(assessment.sessionId)) latest.set(assessment.sessionId, assessment);
    for (const session of sessions) {
      const assessment = latest.get(session.id) ?? null;
      result.set(session.wiseSessionId, { session, assessment,
        policyCurrent: (!inventoryById.get(session.wiseSessionId)?.inventoryChangedAt || Boolean(session.lastObservedAt &&
          session.lastObservedAt >= inventoryById.get(session.wiseSessionId)!.inventoryChangedAt!)) &&
          session.policyVersion === config.policyVersion && session.sourceMetadata.mappingVersion === config.formMappingVersion &&
          (!session.eligible || Boolean(assessment && assessment.policyVersion === config.policyVersion && assessment.mappingVersion === config.formMappingVersion)),
      });
    }
  }
  return result;
}

function disposition(value: LoadedState | undefined, now: Date, cutoff: Date) {
  const state: NightlySessionState | null = value ? {
    ...value.session, deleted: Boolean(value.session.wiseDeletedAt), assessment: value.assessment, policyCurrent: value.policyCurrent,
  } : null;
  return nightlyDisposition(state, now, cutoff);
}

async function recipientFor(db: Database, key: string | null) {
  if (!key) return { email: null, source: "missing" } as const;
  const [contact] = await db.select().from(schema.tutorContacts)
    .where(and(eq(schema.tutorContacts.canonicalKey, key), eq(schema.tutorContacts.active, true))).limit(1);
  return contact ? resolvePostClassTutorRecipient(contact) : { email: null, source: "missing" } as const;
}

async function globalSourceReady(db: Database): Promise<boolean> {
  const config = await settings(db);
  const [issue] = await db.select({ id: schema.postClassSourceIssues.id }).from(schema.postClassSourceIssues)
    .where(and(eq(schema.postClassSourceIssues.scope, "global"), eq(schema.postClassSourceIssues.status, "open"),
      eq(schema.postClassSourceIssues.blocksEnforcement, true))).limit(1);
  return config.formMappingValid && config.enforcementMode === "live" && !issue;
}

async function hasLease(db: Database, token: string, now: Date): Promise<boolean> {
  const [row] = await db.select({ id: schema.postClassReminderWorker.id }).from(schema.postClassReminderWorker)
    .where(and(eq(schema.postClassReminderWorker.id, "nightly"), eq(schema.postClassReminderWorker.leaseToken, token),
      gte(schema.postClassReminderWorker.leaseUntil, new Date(now.getTime() + 120_000)))).limit(1);
  return Boolean(row);
}

async function establishRun(db: Database, date: string, mode: "shadow" | "live", now: Date) {
  const key = `post-class-feedback:nightly:${mode}:${date}`;
  await db.insert(runs).values({ kind: "tutor_nightly", scheduledFor: nightlyCheckpoint(date),
    idempotencyKey: key, startedAt: now, metadata: { date, mode, sourceComplete: false } })
    .onConflictDoNothing({ target: runs.idempotencyKey });
  const [run] = await db.select().from(runs).where(eq(runs.idempotencyKey, key));
  return run;
}

async function seedInventory(db: Database, runId: string, date: string, mode: "shadow" | "live", inventory: NightlyInventory) {
  const window = nightlyWindow(date);
  // Previously known obligations omitted by PAST must be resolved by canonical
  // detail, not erased by an unexpectedly empty listing.
  const persisted = await db.select().from(schema.postClassSessions).where(and(
    gte(schema.postClassSessions.scheduledEndAt, window.start), lte(schema.postClassSessions.scheduledEndAt, window.cutoff),
  ));
  const items = new Map(inventory.items.map((item) => [item.wiseSessionId, item]));
  for (const row of persisted) if (!items.has(row.wiseSessionId)) items.set(row.wiseSessionId, {
    wiseSessionId: row.wiseSessionId, wiseClassId: row.wiseClassId, scheduledEndAt: row.scheduledEndAt,
    deadlineAt: row.deadlineAt, rawSession: null,
  });
  const values = [...items.values()].map((item) => ({ ...item, runId, reminderDate: date, mode, inventoryChangedAt: inventory.checkedAt }));
  for (let index = 0; index < values.length; index += 250) {
    await db.insert(ledger).values(values.slice(index, index + 250)).onConflictDoUpdate({
      target: [ledger.mode, ledger.reminderDate, ledger.wiseSessionId],
      set: { inventoryChangedAt: sql`case when ${ledger.rawSession} is distinct from excluded.raw_session
          or ${ledger.wiseClassId} is distinct from excluded.wise_class_id or ${ledger.scheduledEndAt} is distinct from excluded.scheduled_end_at
          or ${ledger.deadlineAt} is distinct from excluded.deadline_at then excluded.inventory_changed_at else ${ledger.inventoryChangedAt} end`,
        rawSession: sql`excluded.raw_session`, wiseClassId: sql`excluded.wise_class_id`,
        scheduledEndAt: sql`excluded.scheduled_end_at`, deadlineAt: sql`excluded.deadline_at`, updatedAt: inventory.checkedAt },
      setWhere: notInArray(ledger.status, ["sent", "superseded", "unknown"]),
    });
  }
  // Published only after every discovered identifier has a durable ledger row.
  await db.update(runs).set({ metadata: { date, mode, sourceComplete: true, pages: inventory.pages,
    sourceCheckedAt: inventory.checkedAt.toISOString(), startDate: inventory.startDate, endDate: inventory.endDate,
    discovered: inventory.items.length, expectedInventory: items.size }, errorSummary: null, updatedAt: inventory.checkedAt })
    .where(eq(runs.id, runId));
}

async function classifyRows(db: Database, rows: LedgerRow[], now: Date, sourceReady: boolean) {
  const states = await loadStates(db, rows);
  const recipients = new Map<string, Awaited<ReturnType<typeof recipientFor>>>();
  for (const row of rows) {
    if ((NIGHTLY_TERMINAL as readonly string[]).includes(row.status) || row.status === "unknown") continue;
    const value = states.get(row.wiseSessionId);
    let verdict: { status: string; reason: string | null } = sourceReady ? disposition(value, now, nightlyCheckpoint(row.reminderDate))
        : { status: "blocked_source", reason: "Feedback source or policy configuration is unavailable." };
    const tutorKey = value?.session.canonicalTutorKey ?? null;
    if (verdict.status === "ready" && tutorKey) {
      if (!recipients.has(tutorKey)) recipients.set(tutorKey, await recipientFor(db, tutorKey));
      const recipient = recipients.get(tutorKey)!;
      if (!recipient.email) verdict = { status: "blocked_recipient", reason: recipient.source === "conflict"
        ? "Wise accounts have conflicting emails; set a primary reminder address." : "No reminder email is configured." };
      else if (row.deliveryId) verdict.status = row.status === "failed" ? "failed" : "queued";
    }
    await db.update(ledger).set({ ...verdict, sessionId: value?.session.id ?? null, canonicalTutorKey: tutorKey,
      sourceObservedAt: value?.session.lastObservedAt ?? null,
      ...(value && value.session.lastObservedAt && value.session.lastObservedAt.getTime() >= now.getTime() - NIGHTLY_FRESHNESS_MS
        ? { deadlineAt: value.session.deadlineAt, scheduledEndAt: value.session.scheduledEndAt } : {}), updatedAt: now })
      .where(and(eq(ledger.id, row.id), notInArray(ledger.status, [...NIGHTLY_TERMINAL, "unknown"])));
  }
  return states;
}

async function markStaleSendingUnknown(db: Database, now: Date) {
  const stale = await db.select({ id: deliveries.id }).from(deliveries).innerJoin(runs, eq(deliveries.runId, runs.id))
    .where(and(eq(runs.kind, "tutor_nightly"), eq(deliveries.status, "sending"),
      lt(deliveries.updatedAt, new Date(now.getTime() - LEASE_MS))));
  for (const row of stale) await unknownDelivery(db, row.id, now);
}

async function unknownDelivery(db: Database, id: string, now: Date) {
  await withPostClassTransaction(db, async (tx) => {
    const changed = await tx.update(deliveries).set({ status: "unknown", nextAttemptAt: null,
      finalError: "Email acceptance is uncertain. Check the sending mailbox before resolving.", updatedAt: now })
      .where(and(eq(deliveries.id, id), eq(deliveries.status, "sending"))).returning({ id: deliveries.id });
    if (!changed.length) return;
    await tx.update(attempts).set({ status: "unknown", errorCode: "acceptance_unknown", finishedAt: now })
      .where(and(eq(attempts.deliveryId, id), eq(attempts.status, "sending")));
    await tx.update(ledger).set({ status: "unknown", reason: "Email acceptance requires reconciliation.", updatedAt: now })
      .where(and(eq(ledger.deliveryId, id), ne(ledger.status, "sent")));
  });
}

async function supersedeOldNights(db: Database, runId: string, date: string, now: Date) {
  await withPostClassTransaction(db, async (tx) => {
    const older = await tx.select({ id: deliveries.id }).from(deliveries).innerJoin(runs, eq(deliveries.runId, runs.id))
      .where(and(eq(runs.kind, "tutor_nightly"), lt(runs.scheduledFor, nightlyCheckpoint(date)),
        inArray(deliveries.status, ["pending", "failed"])));
    if (older.length) await tx.update(deliveries).set({ status: "cancelled", cancelledAt: now, nextAttemptAt: null, updatedAt: now })
      .where(inArray(deliveries.id, older.map((row) => row.id)));
    await tx.update(ledger).set({ status: "expired", reason: "Deadline passed during an interrupted nightly batch.", updatedAt: now })
      .where(and(eq(ledger.mode, "live"), lt(ledger.reminderDate, date), lte(ledger.deadlineAt, now),
        notInArray(ledger.status, [...NIGHTLY_TERMINAL, "unknown"])));
    // A newer night can cover still-current classes, but uncertain messages
    // retain ownership until a human proves whether they were accepted.
    const current = await tx.select({ wiseId: ledger.wiseSessionId }).from(ledger).where(eq(ledger.runId, runId));
    for (let index = 0; index < current.length; index += 500) await tx.update(ledger)
      .set({ status: "superseded", reason: "Consolidated into the next nightly batch.", updatedAt: now })
      .where(and(eq(ledger.mode, "live"), lt(ledger.reminderDate, date),
        inArray(ledger.wiseSessionId, current.slice(index, index + 500).map((row) => row.wiseId)),
        notInArray(ledger.status, [...NIGHTLY_TERMINAL, "unknown"])));
  });
}

function dateLabel(date: Date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function emailContent(db: Database, rows: LedgerRow[], states: Map<string, LoadedState>) {
  rows = rows.toSorted((a, b) => a.scheduledEndAt.getTime() - b.scheduledEndAt.getTime() || a.wiseSessionId.localeCompare(b.wiseSessionId));
  const ids = rows.map((row) => states.get(row.wiseSessionId)?.session.id).filter((id): id is string => Boolean(id));
  const participants = ids.length ? await db.select().from(schema.postClassSessionParticipants)
    .where(inArray(schema.postClassSessionParticipants.sessionId, ids)) : [];
  return buildFeedbackReminderEmail({
    tutorDisplayName: states.get(rows[0]?.wiseSessionId)?.session.canonicalTutorName ?? "Tutor",
    logoUrl: teacherEmailLogoUrl(teacherEmailPublicBaseUrl()),
    items: rows.map((row) => {
      const { session, assessment } = states.get(row.wiseSessionId)!;
      return { className: session.className ?? "Class", students: participants.filter((p) => p.sessionId === session.id)
        .map((p) => p.studentName).join(", ") || "Student name unavailable",
        sessionDate: dateLabel(session.scheduledEndAt), reasons: assessment?.fieldFailures ?? [],
        characters: assessment?.combinedRawCharCount ?? 0, deadline: dateLabel(session.deadlineAt),
        wiseUrl: safePostClassWiseSessionUrl({ configuredUrl: session.sourceMetadata.wiseUrl,
          wiseClassId: session.wiseClassId, wiseSessionId: session.wiseSessionId }) };
    }),
  });
}

async function queueReadyGroups(db: Database, runId: string, now: Date, token: string) {
  let known = await db.select().from(ledger).where(eq(ledger.runId, runId));
  const newTutors = new Set(known.filter((row) => row.status === "ready" && !row.deliveryId).map((row) => row.canonicalTutorKey));
  const unattempted = await db.select().from(deliveries).where(and(eq(deliveries.runId, runId),
    eq(deliveries.status, "pending"), eq(deliveries.attemptCount, 0)));
  for (const delivery of unattempted) if (newTutors.has(delivery.canonicalTutorKey)) {
    await cancelUnacceptedDelivery(db, delivery.id, now);
  }
  if (unattempted.some((delivery) => newTutors.has(delivery.canonicalTutorKey))) {
    known = await db.select().from(ledger).where(eq(ledger.runId, runId));
    await classifyRows(db, known, now, await globalSourceReady(db));
    known = await db.select().from(ledger).where(eq(ledger.runId, runId));
  }
  const ready = known.filter((row) => row.status === "ready" && !row.deliveryId);
  const blockedTutors = new Set(known.filter((row) => ["pending", "queued", "failed", "blocked_source", "blocked_recipient", "unknown"].includes(row.status))
    .map((row) => row.canonicalTutorKey).filter(Boolean));
  const uncertain = await db.select({ wiseId: ledger.wiseSessionId, deliveryId: ledger.deliveryId })
    .from(ledger).innerJoin(deliveries, eq(ledger.deliveryId, deliveries.id))
    .where(inArray(deliveries.status, ["sending", "unknown"]));
  const uncertainById = new Map(uncertain.map((row) => [row.wiseId, row.deliveryId]));
  const groups = new Map<string, LedgerRow[]>();
  for (const row of ready) {
    if (uncertainById.has(row.wiseSessionId)) {
      if (row.canonicalTutorKey) blockedTutors.add(row.canonicalTutorKey);
      await db.update(ledger).set({ status: "unknown", deliveryId: uncertainById.get(row.wiseSessionId),
        reason: "An earlier message for this class has an uncertain outcome.", updatedAt: now }).where(eq(ledger.id, row.id));
    } else if (row.canonicalTutorKey) {
      const group = groups.get(row.canonicalTutorKey) ?? [];
      group.push(row); groups.set(row.canonicalTutorKey, group);
    }
  }
  for (const [tutorKey, items] of groups) {
    if (blockedTutors.has(tutorKey)) continue;
    const recipient = await recipientFor(db, tutorKey);
    if (!recipient.email) continue;
    const states = await loadStates(db, items);
    if (items.some((row) => disposition(states.get(row.wiseSessionId), now, nightlyCheckpoint(row.reminderDate)).status !== "ready")) continue;
    const content = await emailContent(db, items, states);
    await withPostClassTransaction(db, async (tx) => {
      if (!await hasLease(tx, token, now) || (await settings(tx)).reminderMode !== "live") return;
      const id = randomUUID();
      await tx.insert(deliveries).values({ id, runId, canonicalTutorKey: tutorKey, recipientEmail: recipient.email!,
        subject: feedbackReminderSubject, idempotencyKey: `post-class-feedback:nightly:${id}`, nextAttemptAt: now,
        frozenContent: { text: content.text, html: content.html, sessionIds: items.map((row) => states.get(row.wiseSessionId)!.session.id), frozenAt: now.toISOString() },
      });
      await tx.insert(schema.postClassNotificationItems).values(items.map((row) => ({ deliveryId: id,
        sessionId: states.get(row.wiseSessionId)!.session.id, deadlineAt: row.deadlineAt,
        failureReasons: states.get(row.wiseSessionId)!.assessment?.fieldFailures ?? [],
        rawCharCount: states.get(row.wiseSessionId)!.assessment?.combinedRawCharCount ?? 0 })));
      const claimed = await tx.update(ledger).set({ deliveryId: id, status: "queued", updatedAt: now })
        .where(and(inArray(ledger.id, items.map((row) => row.id)), eq(ledger.status, "ready"), isNull(ledger.deliveryId)))
        .returning({ id: ledger.id });
      if (claimed.length !== items.length) throw new PostClassConflictError();
    });
  }
}

async function cancelUnacceptedDelivery(db: Database, id: string, now: Date) {
  await withPostClassTransaction(db, async (tx) => {
    const changed = await tx.update(deliveries).set({ status: "cancelled", cancelledAt: now, nextAttemptAt: null, updatedAt: now })
      .where(and(eq(deliveries.id, id), inArray(deliveries.status, ["pending", "failed"]))).returning({ id: deliveries.id });
    if (!changed.length) return;
    await tx.update(ledger).set({ deliveryId: null, status: "pending", updatedAt: now })
      .where(and(eq(ledger.deliveryId, id), notInArray(ledger.status, [...NIGHTLY_TERMINAL, "unknown"])));
  });
}

async function acceptDeliveryInTransaction(tx: Database, id: string, attemptNumber: number, receipt: string, now: Date) {
    await tx.update(attempts).set({ status: "sent", providerMessageId: receipt, finishedAt: now })
      .where(and(eq(attempts.deliveryId, id), eq(attempts.attemptNumber, attemptNumber)));
    const [delivery] = await tx.update(deliveries).set({ status: "sent", providerMessageId: receipt,
      sentAt: now, nextAttemptAt: null, finalError: null, updatedAt: now }).where(eq(deliveries.id, id)).returning();
    await tx.update(ledger).set({ status: "sent", reason: "Email relay accepted the message.", updatedAt: now })
      .where(and(eq(ledger.deliveryId, id), eq(ledger.runId, delivery.runId)));
    await tx.update(ledger).set({ status: "superseded", reason: "Earlier message acceptance was reconciled.", updatedAt: now })
      .where(and(eq(ledger.deliveryId, id), ne(ledger.runId, delivery.runId)));
}

async function dispatchDelivery(db: Database, id: string, token: string, clock: () => Date,
  senders?: { primary: ScheduleEmailSender; backup: ScheduleEmailSender }) {
  const now = clock();
  const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, id));
  if (!delivery?.frozenContent || !["pending", "failed"].includes(delivery.status) || delivery.attemptCount >= 4) return;
  const config = await settings(db);
  if (config.reminderMode !== "live" || !await hasLease(db, token, now) || !await globalSourceReady(db)) return;
  const [run] = await db.select().from(runs).where(eq(runs.id, delivery.runId));
  if (!config.reminderActivatedAt || run.scheduledFor < config.reminderActivatedAt) return;
  const rows = await db.select().from(ledger).where(and(eq(ledger.deliveryId, id), eq(ledger.runId, delivery.runId)));
  const states = await loadStates(db, rows);
  const verdicts = rows.map((row) => disposition(states.get(row.wiseSessionId), now, nightlyCheckpoint(row.reminderDate)));
  if (verdicts.some((v) => v.status === "blocked_source")) return;
  const recipient = await recipientFor(db, delivery.canonicalTutorKey);
  if (!rows.length || verdicts.some((v) => v.status !== "ready") || recipient.email !== delivery.recipientEmail ||
      rows.length !== delivery.frozenContent.sessionIds.length || rows.some((row) =>
        states.get(row.wiseSessionId)?.session.canonicalTutorKey !== delivery.canonicalTutorKey ||
        !delivery.frozenContent!.sessionIds.includes(states.get(row.wiseSessionId)!.session.id))) {
    await cancelUnacceptedDelivery(db, id, now); return;
  }
  const currentContent = await emailContent(db, rows, states);
  if (currentContent.text !== delivery.frozenContent.text || currentContent.html !== delivery.frozenContent.html) {
    await cancelUnacceptedDelivery(db, id, now); return;
  }
  const number = delivery.attemptCount + 1;
  const senderKey = number === 1 ? "primary" : "backup";
  const provider = senders ? senderKey : "gmail";
  const claimed = await withPostClassTransaction(db, async (tx) => {
    const currentConfig = await settings(tx);
    if (!await hasLease(tx, token, clock()) || currentConfig.reminderMode !== "live" ||
        currentConfig.enforcementMode !== "live" || !currentConfig.formMappingValid ||
        currentConfig.policyVersion !== config.policyVersion || currentConfig.formMappingVersion !== config.formMappingVersion ||
        rows.some((row) => disposition(states.get(row.wiseSessionId), clock(), nightlyCheckpoint(row.reminderDate)).status !== "ready")) return false;
    const claimedRows = await tx.update(deliveries).set({ status: "sending", provider, attemptCount: number, updatedAt: now })
      .where(and(eq(deliveries.id, id), eq(deliveries.attemptCount, delivery.attemptCount),
        inArray(deliveries.status, ["pending", "failed"]), lte(deliveries.nextAttemptAt, now)))
      .returning({ id: deliveries.id });
    if (!claimedRows.length) return false;
    await tx.insert(attempts).values({ deliveryId: id, attemptNumber: number, provider, status: "sending", startedAt: now });
    return true;
  });
  if (!claimed) return;
  let receipt: { id: string };
  try {
    const sender = senders?.[senderKey] ?? createGmailSender(force => feedbackGmailAccessToken(force, db), async () => {
      const current = await settings(db);
      const finalStates = await loadStates(db, rows);
      const finalRecipient = await recipientFor(db, delivery.canonicalTutorKey);
      const content = await emailContent(db, rows, finalStates);
      if (current.reminderMode !== "live" || !await hasLease(db, token, clock()) || !await globalSourceReady(db) ||
        current.policyVersion !== config.policyVersion || current.formMappingVersion !== config.formMappingVersion ||
        finalRecipient.email !== delivery.recipientEmail || content.text !== delivery.frozenContent!.text || content.html !== delivery.frozenContent!.html ||
        rows.some(row => disposition(finalStates.get(row.wiseSessionId), clock(), nightlyCheckpoint(row.reminderDate)).status !== "ready")) {
        throw new GmailRejection("Reminder eligibility changed before submission; refresh the queued classes.", true);
      }
    });
    receipt = await sender.sendEmail({ to: delivery.recipientEmail, subject: delivery.subject,
      text: delivery.frozenContent.text, html: delivery.frozenContent.html, idempotencyKey: delivery.idempotencyKey });
  } catch (error) {
    if (!(error instanceof ScheduleEmailRejection)) { await unknownDelivery(db, id, clock()); return; }
    const failedAt = clock();
    const gmail = error instanceof GmailRejection ? error : null;
    const retryAt = number < 4 && !gmail?.permanent
      ? new Date(Math.max(failedAt.getTime() + NIGHTLY_RETRY_MINUTES[number - 1] * 60_000, gmail?.retryAt?.getTime() ?? 0)) : null;
    const reason = gmail?.message ?? "The email service rejected this message.";
    await withPostClassTransaction(db, async (tx) => {
      await tx.update(attempts).set({ status: "failed", errorCode: gmail ? "gmail_rejected" : "relay_rejected", errorMessage: reason, finishedAt: failedAt })
        .where(and(eq(attempts.deliveryId, id), eq(attempts.attemptNumber, number)));
      await tx.update(deliveries).set({ status: "failed", nextAttemptAt: retryAt,
        finalError: reason, updatedAt: failedAt }).where(eq(deliveries.id, id));
      await tx.update(ledger).set({ status: "failed", reason, updatedAt: failedAt })
        .where(eq(ledger.deliveryId, id));
    });
    return;
  }
  // Acceptance and local persistence are separate failure domains. A failed
  // commit remains sending/unknown and will never switch relay automatically.
  try {
    if (typeof receipt.id !== "string" || !receipt.id.trim()) throw new Error("Missing acceptance receipt");
    await withPostClassTransaction(db, (tx) => acceptDeliveryInTransaction(tx, id, number, receipt.id, clock()));
  }
  catch { await unknownDelivery(db, id, clock()); }
}

async function finishRun(db: Database, runId: string, now: Date, sourceReady: boolean, checkedPolicy: { policyVersion: number; formMappingVersion: number }) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const rows = await db.select().from(ledger).where(eq(ledger.runId, runId));
  const counts = nightlyCounts(rows);
  const shadow = run.metadata.mode === "shadow";
  const config = await settings(db);
  const unresolved = counts.blockedSource + counts.blockedRecipient + counts.unknown + counts.failed + counts.pending + (shadow ? 0 : counts.ready);
  const policyUnchanged = config.policyVersion === checkedPolicy.policyVersion && config.formMappingVersion === checkedPolicy.formMappingVersion;
  const ok = run.metadata.sourceComplete === true && sourceReady && policyUnchanged && unresolved === 0 && (shadow || counts.expired === 0);
  const mail = await db.select({ status: deliveries.status }).from(deliveries).where(eq(deliveries.runId, runId));
  await db.update(runs).set({ status: ok ? (mail.some((row) => row.status === "sent") ? "sent" : "cancelled") : "failed",
    eligibleCount: rows.length - counts.excluded, deliveryCount: mail.length,
    sentCount: mail.filter((row) => row.status === "sent").length, failedCount: mail.filter((row) => ["failed", "unknown"].includes(row.status)).length,
    metadata: { ...run.metadata, counts, shadowComplete: shadow && ok, checkedAt: now.toISOString(),
      policyVersion: checkedPolicy.policyVersion, mappingVersion: checkedPolicy.formMappingVersion },
    finishedAt: now, updatedAt: now,
  }).where(eq(runs.id, runId));
  return { ok, failure: !sourceReady || !policyUnchanged || run.metadata.sourceComplete !== true || counts.unknown > 0 || counts.failed > 0, mode: shadow ? "shadow" as const : "live" as const, runId, date: String(run.metadata.date), counts };
}

/** Owns nightly scheduling and delivery; does not approve or publish deductions. */
export async function runNightlyReminders(options: NightlyReminderOptions = {}) {
  const db = options.db ?? getDb();
  const clock = options.clock ?? (options.now ? () => options.now! : () => new Date());
  const now = clock();
  const config = await settings(db);
  await markStaleSendingUnknown(db, now);
  if (options.shadowPreview && config.reminderMode !== "shadow") throw new PostClassValidationError("Shadow previews require shadow mode.");
  if (config.reminderMode === "off") return { ok: true, mode: "off" as const, skipped: "Reminders are off." };
  const mode = config.reminderMode;
  const date = latestNightlyDate(now, mode === "live" ? config.reminderActivatedAt : options.shadowPreview ? new Date(0) : config.reminderStartedAt);
  if (!date) return { ok: true, mode, skipped: "Waiting for the first prospective 22:00 Bangkok checkpoint." };
  const token = randomUUID();
  const lease = await db.insert(schema.postClassReminderWorker).values({ id: "nightly", leaseToken: token,
    leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
    .onConflictDoUpdate({ target: schema.postClassReminderWorker.id,
      set: { leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now },
      setWhere: lte(schema.postClassReminderWorker.leaseUntil, now) }).returning();
  if (!lease.length) return { ok: false, mode, skipped: "Another nightly worker is in progress." };
  try {
    const run = await establishRun(db, date, mode, now);
    await markStaleSendingUnknown(db, now);
    try {
      const inventory = await (options.discover ?? discoverNightlyInventory)(date);
      const window = nightlyWindow(date);
      if (inventory.pages < 1 || inventory.startDate !== window.startDate || inventory.endDate !== window.endDate ||
          inventory.checkedAt.getTime() < clock().getTime() - NIGHTLY_FRESHNESS_MS) {
        throw new Error("Incomplete or stale nightly source proof.");
      }
      await seedInventory(db, run.id, date, mode, inventory);
    } catch {
      await db.update(runs).set({ status: "failed", errorSummary: "Wise nightly discovery could not be verified.",
        metadata: { ...run.metadata, sourceComplete: false }, updatedAt: clock() }).where(eq(runs.id, run.id));
      return await finishRun(db, run.id, clock(), false, config);
    }
    if (mode === "live") await supersedeOldNights(db, run.id, date, clock());
    const exclusions = await db.select().from(ledger).where(and(eq(ledger.runId, run.id), inArray(ledger.status, ["excluded", "expired"])));
    const exclusionStates = await loadStates(db, exclusions);
    const obsolete = exclusions.filter((row) => (row.status !== "expired" || row.deadlineAt > clock()) && exclusionStates.get(row.wiseSessionId)?.policyCurrent === false);
    if (obsolete.length) await db.update(ledger).set({ status: "pending", reason: "Policy changed; refresh required." })
      .where(inArray(ledger.id, obsolete.map((row) => row.id)));
    for (let batch = 0; batch < (options.maxRefreshBatches ?? 8) && clock().getTime() - now.getTime() < BUDGET_MS; batch++) {
      const rows = await db.select().from(ledger).where(and(eq(ledger.runId, run.id), notInArray(ledger.status, [...NIGHTLY_TERMINAL, "unknown"])))
        .orderBy(sql`${ledger.lastCheckedAt} asc nulls first`, asc(ledger.id));
      const states = await loadStates(db, rows);
      const stale = rows.filter((row) =>
        (!row.lastCheckedAt || row.lastCheckedAt < now) &&
        disposition(states.get(row.wiseSessionId), clock(), nightlyCheckpoint(date)).status === "blocked_source").slice(0, 50);
      if (!stale.length) break;
      await db.update(ledger).set({ lastCheckedAt: clock() }).where(inArray(ledger.id, stale.map((row) => row.id)));
      try { await (options.refresh ?? refreshNightlyItems)(stale, clock()); }
      catch { /* Each affected ledger row stays blocked. Other tutors can proceed. */ }
    }
    const sourceReady = await globalSourceReady(db);
    const rows = await db.select().from(ledger).where(eq(ledger.runId, run.id));
    await classifyRows(db, rows, clock(), sourceReady);
    if (mode === "live" && sourceReady && clock().getTime() - now.getTime() < BUDGET_MS) {
      await queueReadyGroups(db, run.id, clock(), token);
      const due = await db.select({ id: deliveries.id }).from(deliveries).where(and(eq(deliveries.runId, run.id),
        inArray(deliveries.status, ["pending", "failed"]), lte(deliveries.nextAttemptAt, clock()))).orderBy(asc(deliveries.createdAt));
      const senders = options.senders;
      for (const item of due) {
        if (clock().getTime() - now.getTime() >= BUDGET_MS) break;
        await dispatchDelivery(db, item.id, token, clock, senders);
      }
    }
    return await finishRun(db, run.id, clock(), sourceReady, config);
  } finally {
    await db.update(schema.postClassReminderWorker).set({ leaseUntil: clock(), updatedAt: clock() })
      .where(and(eq(schema.postClassReminderWorker.id, "nightly"), eq(schema.postClassReminderWorker.leaseToken, token)));
  }
}

export async function resolveNightlyUnknown(input: { deliveryId: string; outcome: "accepted" | "not_sent";
  receipt?: string; note: string; expectedAttempt: number }, actorEmail: string, db: Database = getDb()) {
  if (input.note.trim().length < 10 || (input.outcome === "accepted" && !input.receipt?.trim())) {
    throw new PostClassValidationError("Record the mailbox evidence and an acceptance receipt where applicable.");
  }
  await withPostClassTransaction(db, async (tx) => {
    const [delivery] = await tx.select().from(deliveries).where(eq(deliveries.id, input.deliveryId)).for("update");
    const [run] = delivery ? await tx.select().from(runs).where(eq(runs.id, delivery.runId)) : [];
    if (!delivery || run?.kind !== "tutor_nightly" || delivery.status !== "unknown" || delivery.attemptCount !== input.expectedAttempt) {
      throw new PostClassConflictError();
    }
    const now = new Date();
    if (input.outcome === "accepted") {
      await acceptDeliveryInTransaction(tx, delivery.id, delivery.attemptCount, input.receipt!.trim(), now);
    } else {
      // Retain the uncertain attempt and immutable payload as audit evidence;
      // a fresh delivery can be composed only after fresh feedback checks.
      await tx.update(deliveries).set({ status: "cancelled", cancelledAt: now, nextAttemptAt: null, updatedAt: now }).where(eq(deliveries.id, delivery.id));
      await tx.update(attempts).set({ status: "failed", errorCode: "operator_verified_not_sent", finishedAt: now })
        .where(and(eq(attempts.deliveryId, delivery.id), eq(attempts.attemptNumber, delivery.attemptCount)));
      await tx.update(ledger).set({ status: "pending", deliveryId: null, reason: "Operator verified that the previous message was not sent.", updatedAt: now })
        .where(eq(ledger.deliveryId, delivery.id));
    }
    await tx.insert(schema.postClassConfigAuditLog).values({ entityType: "nightly_reminder", entityKey: delivery.id,
      action: `resolve_${input.outcome}`, actorEmail, beforeValue: { status: "unknown", attempt: delivery.attemptCount },
      afterValue: { outcome: input.outcome, receipt: input.receipt ?? null }, note: input.note.trim() });
  });
}

export async function previewNightlyRun(runId: string, db: Database = getDb()) {
  const rows = await db.select().from(ledger).where(and(eq(ledger.runId, runId), inArray(ledger.status, ["ready", "queued"])));
  const states = await loadStates(db, rows);
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) if (row.canonicalTutorKey && states.has(row.wiseSessionId)) {
    groups.set(row.canonicalTutorKey, [...(groups.get(row.canonicalTutorKey) ?? []), row]);
  }
  return Promise.all([...groups].map(async ([key, items]) => ({ tutorKey: key,
    recipient: await recipientFor(db, key), classes: items.length, ...await emailContent(db, items, states) })));
}

/** A bounded worker pass can succeed while durable work remains for recovery. */
export function nightlyWorkerOutcome(result: Awaited<ReturnType<typeof runNightlyReminders>>) {
  return { ...result, complete: result.ok, ok: !("failure" in result && result.failure),
    ...("skipped" in result ? { skipped: true, message: result.skipped } : {}),
  };
}
