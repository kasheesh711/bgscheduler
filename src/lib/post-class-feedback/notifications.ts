import { createHash } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  createAppsScriptScheduleEmailSender,
  type ScheduleEmailSender,
  type ScheduleEmailSenderKey,
} from "@/lib/classrooms/schedule-email";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  addBangkokDays,
  bangkokDateStartUtc,
  todayBangkok,
} from "@/lib/room-capacity/dates";

import { PostClassValidationError } from "./errors";
import { POST_CLASS_MIN_COMBINED_CHARACTERS } from "./policy";
import { withPostClassTransaction } from "./transaction";

type ReminderKind = "tutor_day_after" | "tutor_deadline";

const MAX_ATTEMPTS = 4;
const RETRY_BACKOFF_MINUTES = [30, 90, 180] as const;
const STALE_MEMBERSHIP_RECHECK_MINUTES = 30;
const SENDING_STALE_MS = 20 * 60 * 1000;
const WORKSPACE_URL = "https://bgscheduler.vercel.app/post-class-feedback";

export interface PostClassNotificationSenders {
  primary: ScheduleEmailSender;
  backup: ScheduleEmailSender;
}

export interface PostClassReminderResult {
  runId: string;
  duplicate: boolean;
  eligible: number;
  deliveries: number;
  sent: number;
  failed: number;
  cancelled: number;
  unresolvedRecipients: number;
}

interface ReminderCandidate {
  sessionId: string;
  canonicalTutorKey: string;
  canonicalTutorName: string;
  failureReasons: string[];
  rawCharCount: number;
  deadlineAt: Date;
}

interface NotificationDeliveryState {
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  attemptCount: number;
  nextAttemptAt: Date | null;
}

export type PostClassReminderMembershipState = "active" | "stale" | "inactive";

export function classifyPostClassReminderMembership(input: {
  eligible: boolean;
  enforcementMode: string;
  sourceStatus: string;
  assessmentSourceStatus: string;
  policyApplies: boolean;
  adjustedCompliant: boolean;
  requiredFieldsPassed: boolean;
  combinedRawCharCount: number;
  lastObservedAt: Date | null;
  freshAfter: Date;
}): PostClassReminderMembershipState {
  const currentContentCompliant = input.requiredFieldsPassed &&
    input.combinedRawCharCount >= POST_CLASS_MIN_COMBINED_CHARACTERS;
  const otherwiseEligible = input.eligible &&
    input.enforcementMode === "live" &&
    input.sourceStatus === "ready" &&
    input.assessmentSourceStatus === "ready" &&
    input.policyApplies &&
    !input.adjustedCompliant &&
    !currentContentCompliant;
  if (!otherwiseEligible) return "inactive";
  return input.lastObservedAt && input.lastObservedAt >= input.freshAfter
    ? "active"
    : "stale";
}

export function planPostClassReminderMemberships(
  states: readonly PostClassReminderMembershipState[],
): { disposition: "send" | "defer" | "cancel"; activeIndexes: number[] } {
  if (states.includes("stale")) return { disposition: "defer", activeIndexes: [] };
  const activeIndexes = states.flatMap((state, index) => state === "active" ? [index] : []);
  return activeIndexes.length > 0
    ? { disposition: "send", activeIndexes }
    : { disposition: "cancel", activeIndexes: [] };
}

export function postClassAdminDigestSince(
  now: Date,
  priorSuccessfulScheduledFor: Date | null,
): Date {
  return priorSuccessfulScheduledFor ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

export function summarizePostClassDigestDeductions(
  rows: readonly { status: string; createdAt: Date }[],
  since: Date,
): { newViolations: number; pendingDeductions: number } {
  return {
    // Creation is the violation event. A later review decision must not erase
    // it from the next digest's new-violation window.
    newViolations: rows.filter((row) => row.createdAt >= since).length,
    pendingDeductions: rows.filter((row) => row.status === "pending_review").length,
  };
}

export function summarizePostClassNotificationRun(
  rows: readonly NotificationDeliveryState[],
  unresolvedRecipients = 0,
) {
  const sent = rows.filter((row) => row.status === "sent").length;
  const terminalFailed = rows.filter((row) =>
    row.status === "failed" &&
    (row.attemptCount >= MAX_ATTEMPTS || !row.nextAttemptAt)).length;
  const active = rows.some((row) =>
    row.status === "pending" ||
    row.status === "sending" ||
    (row.status === "failed" && row.attemptCount < MAX_ATTEMPTS && Boolean(row.nextAttemptAt)));
  const cancelled = rows.filter((row) => row.status === "cancelled").length + unresolvedRecipients;
  return {
    sent,
    failed: terminalFailed,
    cancelled,
    active,
    status: active
      ? "sending" as const
      : terminalFailed > 0 ? "failed" as const
        : sent > 0 ? "sent" as const : "cancelled" as const,
  };
}

export function postClassRemindersEnabledForState(input: {
  mode: "shadow" | "live" | "paused" | null;
  mappingValid: boolean;
  hasBlockingGlobalIssue: boolean;
}): boolean {
  return input.mode === "live" && input.mappingValid && !input.hasBlockingGlobalIssue;
}

export function postClassSenderKeyForAttempt(attemptNumber: number): ScheduleEmailSenderKey {
  return attemptNumber === 1 ? "primary" : "backup";
}

export function shouldRecoverPostClassSendingAttempt(input: {
  status: NotificationDeliveryState["status"];
  updatedAt: Date;
  now: Date;
}): boolean {
  return input.status === "sending" &&
    input.updatedAt <= new Date(input.now.getTime() - SENDING_STALE_MS);
}

function defaultSenders(): PostClassNotificationSenders {
  return {
    primary: createAppsScriptScheduleEmailSender("primary"),
    backup: createAppsScriptScheduleEmailSender("backup"),
  };
}

function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function resolvePostClassTutorRecipient(input: {
  primaryEmail?: string | null;
  onsiteEmail?: string | null;
  onlineEmail?: string | null;
}): { email: string | null; source: "primary" | "wise_fallback" | "missing" | "conflict" } {
  const primary = normalizeEmail(input.primaryEmail);
  if (primary) return { email: primary, source: "primary" };
  const wiseEmails = [...new Set([
    normalizeEmail(input.onsiteEmail),
    normalizeEmail(input.onlineEmail),
  ].filter((value): value is string => Boolean(value)))];
  if (wiseEmails.length === 1) return { email: wiseEmails[0], source: "wise_fallback" };
  return { email: null, source: wiseEmails.length > 1 ? "conflict" : "missing" };
}

function bangkokDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function displayBangkok(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function safePostClassWiseSessionUrl(input: {
  configuredUrl: unknown;
  wiseClassId: string;
  wiseSessionId: string;
}): string {
  const fallback = `https://app.wise.live/classes/${encodeURIComponent(input.wiseClassId)}/sessions/${encodeURIComponent(input.wiseSessionId)}`;
  if (typeof input.configuredUrl !== "string") return fallback;
  try {
    const url = new URL(input.configuredUrl);
    const host = url.hostname.toLowerCase();
    const allowedHost = host === "wise.live" || host.endsWith(".wise.live") ||
      host === "wiseapp.live" || host.endsWith(".wiseapp.live");
    return url.protocol === "https:" && allowedHost ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function policyApplies(details: Record<string, unknown>): boolean {
  return details.policyApplies === true;
}

export function buildPostClassNotificationKey(parts: string[]): string {
  const raw = `post-class-feedback:${parts.join(":")}`;
  if (raw.length <= 250) return raw;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  return `${raw.slice(0, 217)}:${digest}`;
}

function safeEmailError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : "";
  if (/not configured/i.test(message)) {
    return { code: "relay_not_configured", message: "The selected email relay is not configured." };
  }
  if (/quota/i.test(message)) {
    return { code: "relay_quota", message: "The selected email relay has no remaining quota." };
  }
  if (/HTTP 4\d\d/i.test(message)) {
    return { code: "relay_rejected", message: "The email relay rejected the delivery request." };
  }
  return { code: "relay_failed", message: "The email relay request failed." };
}

async function latestAssessments(
  db: Database,
  sessionIds: string[],
): Promise<Map<string, typeof schema.postClassAssessments.$inferSelect>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db.select().from(schema.postClassAssessments)
    .where(inArray(schema.postClassAssessments.sessionId, sessionIds))
    .orderBy(
      desc(schema.postClassAssessments.assessedAt),
      desc(schema.postClassAssessments.createdAt),
    );
  const bySession = new Map<string, typeof schema.postClassAssessments.$inferSelect>();
  for (const row of rows) {
    if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, row);
  }
  return bySession;
}

function stillNeedsReminder(input: {
  session: typeof schema.postClassSessions.$inferSelect;
  assessment: typeof schema.postClassAssessments.$inferSelect | undefined;
  freshAfter?: Date;
}): boolean {
  const { session, assessment } = input;
  if (!assessment) return false;
  return classifyPostClassReminderMembership({
    eligible: session.eligible,
    enforcementMode: session.enforcementMode,
    sourceStatus: session.sourceStatus,
    // assessment.sourceReady is a denominator flag and remains false while a
    // missing comment is not yet due. Reminder readiness is based on the
    // canonical source status instead.
    assessmentSourceStatus: assessment.sourceStatus,
    policyApplies: policyApplies(assessment.details),
    adjustedCompliant: assessment.adjustedCompliant,
    requiredFieldsPassed: assessment.requiredFieldsPassed,
    combinedRawCharCount: assessment.combinedRawCharCount,
    lastObservedAt: session.lastObservedAt,
    freshAfter: input.freshAfter ?? new Date(0),
  }) === "active";
}

async function remindersGloballyEnabled(db: Database): Promise<boolean> {
  const [settings, blockingGlobalIssue] = await Promise.all([
    db.select({
      mode: schema.postClassSettings.enforcementMode,
      mappingValid: schema.postClassSettings.formMappingValid,
    }).from(schema.postClassSettings).limit(1).then((rows) => rows[0] ?? null),
    db.select({ id: schema.postClassSourceIssues.id })
      .from(schema.postClassSourceIssues)
      .where(and(
        eq(schema.postClassSourceIssues.scope, "global"),
        eq(schema.postClassSourceIssues.status, "open"),
        eq(schema.postClassSourceIssues.blocksEnforcement, true),
      )).limit(1).then((rows) => rows[0] ?? null),
  ]);
  return postClassRemindersEnabledForState({
    mode: settings?.mode ?? null,
    mappingValid: settings?.mappingValid ?? false,
    hasBlockingGlobalIssue: Boolean(blockingGlobalIssue),
  });
}

async function loadReminderCandidates(
  db: Database,
  kind: ReminderKind,
  now: Date,
): Promise<ReminderCandidate[]> {
  if (!await remindersGloballyEnabled(db)) return [];

  const today = todayBangkok(now);
  const start = kind === "tutor_day_after"
    ? bangkokDateStartUtc(addBangkokDays(today, -1))
    : bangkokDateStartUtc(today);
  const end = kind === "tutor_day_after"
    ? bangkokDateStartUtc(today)
    : bangkokDateStartUtc(addBangkokDays(today, 1));
  const timeColumn = kind === "tutor_day_after"
    ? schema.postClassSessions.scheduledEndAt
    : schema.postClassSessions.deadlineAt;
  const sessions = await db.select().from(schema.postClassSessions)
    .where(and(
      eq(schema.postClassSessions.eligible, true),
      eq(schema.postClassSessions.enforcementMode, "live"),
      eq(schema.postClassSessions.sourceStatus, "ready"),
      lt(timeColumn, end),
      sql`${timeColumn} >= ${start}`,
    ))
    .orderBy(asc(schema.postClassSessions.deadlineAt));
  const assessments = await latestAssessments(db, sessions.map((session) => session.id));
  return sessions.flatMap((session): ReminderCandidate[] => {
    const assessment = assessments.get(session.id);
    if (!session.canonicalTutorKey || !stillNeedsReminder({
      session,
      assessment,
      freshAfter: new Date(now.getTime() - 20 * 60_000),
    })) return [];
    return [{
      sessionId: session.id,
      canonicalTutorKey: session.canonicalTutorKey,
      canonicalTutorName: session.canonicalTutorName ?? "Tutor",
      failureReasons: safeStringArray(assessment?.fieldFailures),
      rawCharCount: assessment?.combinedRawCharCount ?? 0,
      deadlineAt: session.deadlineAt,
    }];
  });
}

async function resolveRecipientMap(
  db: Database,
  tutorKeys: string[],
): Promise<Map<string, ReturnType<typeof resolvePostClassTutorRecipient>>> {
  if (tutorKeys.length === 0) return new Map();
  const contacts = await db.select({
    canonicalKey: schema.tutorContacts.canonicalKey,
    primaryEmail: schema.tutorContacts.primaryEmail,
    onsiteEmail: schema.tutorContacts.onsiteEmail,
    onlineEmail: schema.tutorContacts.onlineEmail,
  }).from(schema.tutorContacts).where(and(
    inArray(schema.tutorContacts.canonicalKey, tutorKeys),
    eq(schema.tutorContacts.active, true),
  ));
  return new Map(contacts.map((contact) => [
    contact.canonicalKey,
    resolvePostClassTutorRecipient(contact),
  ]));
}

async function loadActiveDigestRecipients(db: Database): Promise<string[]> {
  const rows = await db.select({ email: schema.postClassDigestRecipients.email })
    .from(schema.postClassDigestRecipients)
    .innerJoin(
      schema.adminUsers,
      sql<boolean>`lower(btrim(${schema.adminUsers.email})) = lower(btrim(${schema.postClassDigestRecipients.email}))`,
    )
    .where(eq(schema.postClassDigestRecipients.enabled, true));
  return [...new Set(rows.flatMap((row) => {
    const email = normalizeEmail(row.email);
    return email ? [email] : [];
  }))];
}

async function currentDeliveryRecipient(
  db: Database,
  input: {
    kind: typeof schema.postClassNotificationRuns.$inferSelect["kind"];
    canonicalTutorKey: string | null;
    recipientEmail: string;
  },
): Promise<string | null> {
  if (input.kind === "admin_digest") {
    const recipients = await loadActiveDigestRecipients(db);
    const expected = normalizeEmail(input.recipientEmail);
    return expected && recipients.includes(expected) ? expected : null;
  }
  if (!input.canonicalTutorKey) return null;
  const [contact] = await db.select({
    primaryEmail: schema.tutorContacts.primaryEmail,
    onsiteEmail: schema.tutorContacts.onsiteEmail,
    onlineEmail: schema.tutorContacts.onlineEmail,
  }).from(schema.tutorContacts).where(and(
    eq(schema.tutorContacts.canonicalKey, input.canonicalTutorKey),
    eq(schema.tutorContacts.active, true),
  )).limit(1);
  return contact ? resolvePostClassTutorRecipient(contact).email : null;
}

async function createReminderRun(
  db: Database,
  kind: ReminderKind,
  now: Date,
): Promise<{ runId: string; duplicate: boolean; deliveryIds: string[]; eligible: number; unresolved: number }> {
  const runKey = buildPostClassNotificationKey([kind, bangkokDate(now)]);
  return withPostClassTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runKey}))`);
    const [created] = await tx.insert(schema.postClassNotificationRuns).values({
      kind,
      status: "pending",
      scheduledFor: now,
      idempotencyKey: runKey,
      startedAt: now,
    }).onConflictDoNothing({ target: schema.postClassNotificationRuns.idempotencyKey })
      .returning({ id: schema.postClassNotificationRuns.id });
    const [existing] = created ? [] : await tx.select({ id: schema.postClassNotificationRuns.id })
      .from(schema.postClassNotificationRuns)
      .where(eq(schema.postClassNotificationRuns.idempotencyKey, runKey))
      .limit(1);
    const runId = created?.id ?? existing?.id;
    if (!runId) throw new Error("Could not establish a durable reminder run.");
    const duplicate = !created;

    const candidates = await loadReminderCandidates(tx, kind, now);
    const groups = new Map<string, ReminderCandidate[]>();
    for (const candidate of candidates) {
      const group = groups.get(candidate.canonicalTutorKey) ?? [];
      group.push(candidate);
      groups.set(candidate.canonicalTutorKey, group);
    }
    const recipients = await resolveRecipientMap(tx, [...groups.keys()]);
    const deliveryIds: string[] = [];
    const unresolved: Array<{ tutorKey: string; tutorName: string; reason: string }> = [];
    for (const [tutorKey, items] of groups) {
      const recipient = recipients.get(tutorKey) ?? { email: null, source: "missing" as const };
      if (!recipient.email) {
        unresolved.push({ tutorKey, tutorName: items[0].canonicalTutorName, reason: recipient.source });
        continue;
      }
      const idempotencyKey = buildPostClassNotificationKey([kind, bangkokDate(now), tutorKey]);
      const [createdDelivery] = await tx.insert(schema.postClassNotificationDeliveries).values({
        runId,
        canonicalTutorKey: tutorKey,
        recipientEmail: recipient.email,
        subject: `Post-class feedback due — ${items.length} ${items.length === 1 ? "class" : "classes"}`,
        status: "pending",
        idempotencyKey,
        provider: recipient.source,
        nextAttemptAt: now,
      }).onConflictDoNothing({ target: schema.postClassNotificationDeliveries.idempotencyKey })
        .returning({ id: schema.postClassNotificationDeliveries.id });
      const [existingDelivery] = createdDelivery ? [] : await tx.select({ id: schema.postClassNotificationDeliveries.id })
        .from(schema.postClassNotificationDeliveries)
        .where(eq(schema.postClassNotificationDeliveries.idempotencyKey, idempotencyKey))
        .limit(1);
      const deliveryId = createdDelivery?.id ?? existingDelivery?.id;
      if (!deliveryId) continue;
      await tx.insert(schema.postClassNotificationItems).values(items.map((item) => ({
        deliveryId,
        sessionId: item.sessionId,
        failureReasons: item.failureReasons,
        rawCharCount: item.rawCharCount,
        deadlineAt: item.deadlineAt,
      }))).onConflictDoNothing();
      deliveryIds.push(deliveryId);
    }
    const deliveryStates = deliveryIds.length > 0
      ? await tx.select({
        id: schema.postClassNotificationDeliveries.id,
        status: schema.postClassNotificationDeliveries.status,
        attemptCount: schema.postClassNotificationDeliveries.attemptCount,
        nextAttemptAt: schema.postClassNotificationDeliveries.nextAttemptAt,
        updatedAt: schema.postClassNotificationDeliveries.updatedAt,
      })
        .from(schema.postClassNotificationDeliveries)
        .where(inArray(schema.postClassNotificationDeliveries.id, deliveryIds))
      : [];
    const summary = summarizePostClassNotificationRun(deliveryStates, unresolved.length);
    const staleSendingBefore = new Date(now.getTime() - SENDING_STALE_MS);
    const attemptableDeliveryIds = deliveryStates.flatMap((row) => {
      const duePending = row.status === "pending" && (!row.nextAttemptAt || row.nextAttemptAt <= now);
      const dueRetry = row.status === "failed" && row.attemptCount < MAX_ATTEMPTS &&
        Boolean(row.nextAttemptAt && row.nextAttemptAt <= now);
      const staleSending = row.status === "sending" && row.updatedAt <= staleSendingBefore;
      return duePending || dueRetry || staleSending ? [row.id] : [];
    });
    await tx.update(schema.postClassNotificationRuns).set({
      status: summary.status,
      eligibleCount: candidates.length,
      deliveryCount: deliveryIds.length,
      sentCount: summary.sent,
      failedCount: summary.failed,
      cancelledCount: summary.cancelled,
      metadata: { unresolvedRecipients: unresolved },
      finishedAt: summary.active ? null : new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.postClassNotificationRuns.id, runId));
    return {
      runId,
      duplicate,
      deliveryIds: attemptableDeliveryIds,
      eligible: candidates.length,
      unresolved: unresolved.length,
    };
  });
}

async function reminderContent(db: Database, deliveryId: string, now: Date) {
  const rows = await db.select({
    item: schema.postClassNotificationItems,
    session: schema.postClassSessions,
  }).from(schema.postClassNotificationItems)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassNotificationItems.sessionId, schema.postClassSessions.id),
    )
    .where(eq(schema.postClassNotificationItems.deliveryId, deliveryId))
    .orderBy(asc(schema.postClassSessions.scheduledEndAt));
  const assessments = await latestAssessments(db, rows.map((row) => row.session.id));
  const freshAfter = new Date(now.getTime() - 20 * 60_000);
  const states = rows.map((row): PostClassReminderMembershipState => {
    const assessment = assessments.get(row.session.id);
    if (!assessment) return "inactive";
    return classifyPostClassReminderMembership({
      eligible: row.session.eligible,
      enforcementMode: row.session.enforcementMode,
      sourceStatus: row.session.sourceStatus,
      assessmentSourceStatus: assessment.sourceStatus,
      policyApplies: policyApplies(assessment.details),
      adjustedCompliant: assessment.adjustedCompliant,
      requiredFieldsPassed: assessment.requiredFieldsPassed,
      combinedRawCharCount: assessment.combinedRawCharCount,
      lastObservedAt: row.session.lastObservedAt,
      freshAfter,
    });
  });
  const membershipPlan = planPostClassReminderMemberships(states);
  if (membershipPlan.disposition !== "send") {
    return {
      disposition: membershipPlan.disposition,
      activeCount: 0,
      text: "",
      html: "",
    };
  }
  const activeRows = membershipPlan.activeIndexes.map((index) => rows[index]);
  const participants = activeRows.length > 0
    ? await db.select().from(schema.postClassSessionParticipants)
      .where(inArray(schema.postClassSessionParticipants.sessionId, activeRows.map((row) => row.session.id)))
    : [];
  const names = new Map<string, string[]>();
  for (const participant of participants) {
    const values = names.get(participant.sessionId) ?? [];
    values.push(participant.studentName);
    names.set(participant.sessionId, values);
  }
  const lines = activeRows.map(({ session }) => {
    const assessment = assessments.get(session.id)!;
    const students = names.get(session.id)?.join(", ") || "Student name unavailable";
    const reasons = safeStringArray(assessment.fieldFailures).join("; ") || "Required feedback is incomplete";
    const metadata = safeMetadata(session.sourceMetadata);
    const wiseUrl = safePostClassWiseSessionUrl({
      configuredUrl: metadata.wiseUrl,
      wiseClassId: session.wiseClassId,
      wiseSessionId: session.wiseSessionId,
    });
    return {
      className: session.className ?? "Untitled class",
      students,
      sessionDate: displayBangkok(session.scheduledEndAt),
      reasons,
      characters: assessment.combinedRawCharCount,
      deadline: displayBangkok(session.deadlineAt),
      wiseUrl,
    };
  });
  const text = [
    "Please complete the required post-class feedback in Wise.",
    "",
    ...lines.flatMap((line, index) => [
      `${index + 1}. ${line.className} — ${line.students}`,
      `Session: ${line.sessionDate}`,
      `Needs attention: ${line.reasons}`,
      `Current combined character count: ${line.characters}`,
      `Deadline: ${line.deadline}`,
      `Wise session: ${line.wiseUrl}`,
      "",
    ]),
    "Feedback text is intentionally not included in this email.",
  ].join("\n");
  const htmlItems = lines.map((line) => `
    <li style="margin:0 0 16px">
      <strong>${escapeHtml(line.className)} — ${escapeHtml(line.students)}</strong><br>
      Session: ${escapeHtml(line.sessionDate)}<br>
      Needs attention: ${escapeHtml(line.reasons)}<br>
      Current combined character count: ${line.characters}<br>
      Deadline: ${escapeHtml(line.deadline)}<br>
      <a href="${escapeHtml(line.wiseUrl)}">Open Wise session</a>
    </li>`).join("");
  return {
    disposition: "send" as const,
    activeCount: lines.length,
    text,
    html: `<p>Please complete the required post-class feedback in Wise.</p><ol>${htmlItems}</ol><p><small>Feedback text is intentionally not included in this email.</small></p>`,
  };
}

export function buildPostClassAdminDigestContent(input: {
  newViolations: number;
  pendingDeductions: number;
  pendingAiReviews: number;
  sourceIssueCount: number;
  sourceIssueSamples: readonly { message: string }[];
  reminderFailureCount: number;
  unresolvedRecipients: readonly { tutorName: string; reason: string }[];
}) {
  const counts = {
    newViolations: input.newViolations,
    pendingDeductions: input.pendingDeductions,
    pendingAiReviews: input.pendingAiReviews,
    sourceIssues: input.sourceIssueCount,
    reminderFailures: input.reminderFailureCount,
    unresolvedRecipients: input.unresolvedRecipients.length,
  };
  const issueLines = input.sourceIssueSamples.map((issue) => `- ${issue.message}`);
  const recipientLines = input.unresolvedRecipients.map((recipient) =>
    `- ${recipient.tutorName}: ${recipient.reason === "conflict" ? "conflicting Wise emails" : "no reminder email"}`);
  const text = [
    "Post-class feedback daily admin digest",
    "",
    `New violations: ${counts.newViolations}`,
    `Pending deduction reviews: ${counts.pendingDeductions}`,
    `Pending AI concern reviews: ${counts.pendingAiReviews}`,
    `Open source/form issues: ${counts.sourceIssues}`,
    `Final reminder failures: ${counts.reminderFailures}`,
    `Unresolved tutor recipients: ${counts.unresolvedRecipients}`,
    ...(issueLines.length ? ["", "Source/form issues:", ...issueLines] : []),
    ...(recipientLines.length ? ["", "Tutor recipient issues:", ...recipientLines] : []),
    "",
    `Open workspace: ${WORKSPACE_URL}`,
  ].join("\n");
  const html = `<p><strong>Post-class feedback daily admin digest</strong></p>
    <ul>
      <li>New violations: ${counts.newViolations}</li>
      <li>Pending deduction reviews: ${counts.pendingDeductions}</li>
      <li>Pending AI concern reviews: ${counts.pendingAiReviews}</li>
      <li>Open source/form issues: ${counts.sourceIssues}</li>
      <li>Final reminder failures: ${counts.reminderFailures}</li>
      <li>Unresolved tutor recipients: ${counts.unresolvedRecipients}</li>
    </ul>
    ${input.sourceIssueSamples.length ? `<p><strong>Source/form issues</strong></p><ul>${input.sourceIssueSamples.map((issue) => `<li>${escapeHtml(issue.message)}</li>`).join("")}</ul>` : ""}
    ${input.unresolvedRecipients.length ? `<p><strong>Tutor recipient issues</strong></p><ul>${input.unresolvedRecipients.map((recipient) => `<li>${escapeHtml(recipient.tutorName)}: ${recipient.reason === "conflict" ? "conflicting Wise emails" : "no reminder email"}</li>`).join("")}</ul>` : ""}
    <p><a href="${WORKSPACE_URL}">Open the workspace</a></p>`;
  return { text, html, counts, metadata: { counts } };
}

async function adminDigestContent(db: Database, now: Date) {
  const [priorSuccessfulDigest] = await db.select({
    scheduledFor: schema.postClassNotificationRuns.scheduledFor,
  }).from(schema.postClassNotificationRuns).where(and(
    eq(schema.postClassNotificationRuns.kind, "admin_digest"),
    eq(schema.postClassNotificationRuns.status, "sent"),
    lt(schema.postClassNotificationRuns.scheduledFor, now),
  )).orderBy(desc(schema.postClassNotificationRuns.scheduledFor)).limit(1);
  const since = postClassAdminDigestSince(now, priorSuccessfulDigest?.scheduledFor ?? null);
  const [deductionRows, pendingConcerns, issues, finalFailures, reminderRuns] = await Promise.all([
    db.select({
      status: schema.postClassDeductions.status,
      createdAt: schema.postClassDeductions.createdAt,
    }).from(schema.postClassDeductions).where(or(
      eq(schema.postClassDeductions.status, "pending_review"),
      gte(schema.postClassDeductions.createdAt, since),
    )),
    db.select({ id: schema.postClassAiConcerns.id }).from(schema.postClassAiConcerns)
      .where(eq(schema.postClassAiConcerns.decision, "pending")),
    db.select({
      message: schema.postClassSourceIssues.message,
      totalCount: sql<number>`(count(*) over ())::int`,
    }).from(schema.postClassSourceIssues)
      .where(eq(schema.postClassSourceIssues.status, "open"))
      .orderBy(desc(schema.postClassSourceIssues.lastSeenAt)).limit(12),
    db.select({ count: sql<number>`count(*)::int` })
      .from(schema.postClassNotificationDeliveries)
      .where(and(
        eq(schema.postClassNotificationDeliveries.status, "failed"),
        sql`${schema.postClassNotificationDeliveries.attemptCount} >= ${MAX_ATTEMPTS}`,
      )),
    db.select({ metadata: schema.postClassNotificationRuns.metadata })
      .from(schema.postClassNotificationRuns)
      .where(and(
        inArray(schema.postClassNotificationRuns.kind, ["tutor_day_after", "tutor_deadline"]),
        sql`${schema.postClassNotificationRuns.createdAt} >= ${since}`,
      )),
  ]);
  const unresolvedRecipients = reminderRuns.flatMap((run) => {
    const values = safeMetadata(run.metadata).unresolvedRecipients;
    return Array.isArray(values)
      ? values.flatMap((value) => {
        const row = safeMetadata(value);
        return typeof row.tutorName === "string" && typeof row.reason === "string"
          ? [{ tutorName: row.tutorName, reason: row.reason }]
          : [];
      })
      : [];
  });
  const deductionCounts = summarizePostClassDigestDeductions(deductionRows, since);
  return buildPostClassAdminDigestContent({
    newViolations: deductionCounts.newViolations,
    pendingDeductions: deductionCounts.pendingDeductions,
    pendingAiReviews: pendingConcerns.length,
    sourceIssueCount: issues[0]?.totalCount ?? 0,
    sourceIssueSamples: issues,
    reminderFailureCount: finalFailures[0]?.count ?? 0,
    unresolvedRecipients,
  });
}

async function refreshRunCounts(db: Database, runId: string): Promise<void> {
  const [rows, run] = await Promise.all([
    db.select({
      status: schema.postClassNotificationDeliveries.status,
      attemptCount: schema.postClassNotificationDeliveries.attemptCount,
      nextAttemptAt: schema.postClassNotificationDeliveries.nextAttemptAt,
    })
      .from(schema.postClassNotificationDeliveries)
      .where(eq(schema.postClassNotificationDeliveries.runId, runId)),
    db.select({ metadata: schema.postClassNotificationRuns.metadata })
      .from(schema.postClassNotificationRuns)
      .where(eq(schema.postClassNotificationRuns.id, runId))
      .limit(1)
      .then((values) => values[0] ?? null),
  ]);
  const unresolved = Array.isArray(safeMetadata(run?.metadata).unresolvedRecipients)
    ? (safeMetadata(run?.metadata).unresolvedRecipients as unknown[]).length
    : 0;
  const summary = summarizePostClassNotificationRun(rows, unresolved);
  await db.update(schema.postClassNotificationRuns).set({
    status: summary.status,
    sentCount: summary.sent,
    failedCount: summary.failed,
    cancelledCount: summary.cancelled,
    finishedAt: summary.active ? null : new Date(),
    updatedAt: new Date(),
  }).where(eq(schema.postClassNotificationRuns.id, runId));
}

async function cancelNotificationDelivery(
  db: Database,
  deliveryId: string,
  runId: string,
  now: Date,
  expected: { status: NotificationDeliveryState["status"]; attemptCount: number },
): Promise<"cancelled" | "skipped"> {
  const [cancelled] = await db.update(schema.postClassNotificationDeliveries).set({
    status: "cancelled",
    cancelledAt: now,
    nextAttemptAt: null,
    updatedAt: now,
  }).where(and(
    eq(schema.postClassNotificationDeliveries.id, deliveryId),
    eq(schema.postClassNotificationDeliveries.status, expected.status),
    eq(schema.postClassNotificationDeliveries.attemptCount, expected.attemptCount),
  )).returning({ id: schema.postClassNotificationDeliveries.id });
  if (!cancelled) return "skipped";
  await refreshRunCounts(db, runId);
  return "cancelled";
}

async function deferNotificationDelivery(
  db: Database,
  deliveryId: string,
  runId: string,
  now: Date,
  expected: { status: NotificationDeliveryState["status"]; attemptCount: number },
): Promise<"deferred" | "skipped"> {
  const [deferred] = await db.update(schema.postClassNotificationDeliveries).set({
    ...(expected.status === "sending"
      ? {}
      : {
        nextAttemptAt: new Date(
          now.getTime() + STALE_MEMBERSHIP_RECHECK_MINUTES * 60_000,
        ),
      }),
    updatedAt: now,
  }).where(and(
    eq(schema.postClassNotificationDeliveries.id, deliveryId),
    eq(schema.postClassNotificationDeliveries.status, expected.status),
    eq(schema.postClassNotificationDeliveries.attemptCount, expected.attemptCount),
  )).returning({ id: schema.postClassNotificationDeliveries.id });
  if (!deferred) return "skipped";
  await refreshRunCounts(db, runId);
  return "deferred";
}

async function attemptDelivery(
  db: Database,
  deliveryId: string,
  senders: PostClassNotificationSenders,
  now = new Date(),
): Promise<"sent" | "failed" | "cancelled" | "deferred" | "skipped"> {
  const [loaded] = await db.select({
    delivery: schema.postClassNotificationDeliveries,
    run: schema.postClassNotificationRuns,
  }).from(schema.postClassNotificationDeliveries)
    .innerJoin(schema.postClassNotificationRuns, eq(schema.postClassNotificationDeliveries.runId, schema.postClassNotificationRuns.id))
    .where(eq(schema.postClassNotificationDeliveries.id, deliveryId))
    .limit(1);
  if (!loaded || loaded.delivery.status === "sent" || loaded.delivery.status === "cancelled") return "skipped";
  if (loaded.delivery.attemptCount >= MAX_ATTEMPTS && loaded.delivery.status !== "sending") return "skipped";

  let content: {
    disposition: "send" | "defer" | "cancel";
    activeCount: number;
    text: string;
    html: string;
  };
  if (loaded.run.kind === "tutor_day_after" || loaded.run.kind === "tutor_deadline") {
    // The session's enforcementMode records the historical window. Recheck
    // current global settings as well so a manual pause/form drift/outage stops
    // already queued retries immediately.
    if (!await remindersGloballyEnabled(db)) {
      return cancelNotificationDelivery(db, deliveryId, loaded.run.id, now, loaded.delivery);
    }
    content = await reminderContent(db, deliveryId, now);
    if (content.disposition === "defer") {
      return deferNotificationDelivery(db, deliveryId, loaded.run.id, now, loaded.delivery);
    }
    if (content.disposition === "cancel" || content.activeCount === 0) {
      return cancelNotificationDelivery(db, deliveryId, loaded.run.id, now, loaded.delivery);
    }
  } else {
    const digest = await adminDigestContent(db, now);
    content = { disposition: "send", activeCount: 1, text: digest.text, html: digest.html };
  }

  // Recipient configuration is mutable. Resolve it again immediately before
  // claiming the delivery so removed admins never receive queued digests and a
  // tutor email correction is honored by the next retry.
  const recipientEmail = await currentDeliveryRecipient(db, {
    kind: loaded.run.kind,
    canonicalTutorKey: loaded.delivery.canonicalTutorKey,
    recipientEmail: loaded.delivery.recipientEmail,
  });
  if (!recipientEmail) {
    return cancelNotificationDelivery(db, deliveryId, loaded.run.id, now, loaded.delivery);
  }

  const staleSendingBefore = new Date(now.getTime() - SENDING_STALE_MS);
  const recoveringStaleAttempt = shouldRecoverPostClassSendingAttempt({
    status: loaded.delivery.status,
    updatedAt: loaded.delivery.updatedAt,
    now,
  });
  const [claimed] = recoveringStaleAttempt
    ? await db.update(schema.postClassNotificationDeliveries).set({
      recipientEmail,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassNotificationDeliveries.id, deliveryId),
      eq(schema.postClassNotificationDeliveries.status, "sending"),
      eq(schema.postClassNotificationDeliveries.attemptCount, loaded.delivery.attemptCount),
      lte(schema.postClassNotificationDeliveries.updatedAt, staleSendingBefore),
    )).returning()
    : await db.update(schema.postClassNotificationDeliveries).set({
      status: "sending",
      recipientEmail,
      attemptCount: sql`${schema.postClassNotificationDeliveries.attemptCount} + 1`,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassNotificationDeliveries.id, deliveryId),
      sql`${schema.postClassNotificationDeliveries.attemptCount} < ${MAX_ATTEMPTS}`,
      or(
        and(
          eq(schema.postClassNotificationDeliveries.status, "pending"),
          or(
            isNull(schema.postClassNotificationDeliveries.nextAttemptAt),
            lte(schema.postClassNotificationDeliveries.nextAttemptAt, now),
          ),
        ),
        and(
          eq(schema.postClassNotificationDeliveries.status, "failed"),
          isNotNull(schema.postClassNotificationDeliveries.nextAttemptAt),
          lte(schema.postClassNotificationDeliveries.nextAttemptAt, now),
        ),
      ),
    )).returning();
  if (!claimed) return "skipped";

  const attemptNumber = claimed.attemptCount;
  const senderKey = postClassSenderKeyForAttempt(attemptNumber);
  const sender = senders[senderKey];
  const [createdAttempt] = await db.insert(schema.postClassNotificationAttempts).values({
    deliveryId,
    attemptNumber,
    provider: senderKey,
    status: "sending",
    startedAt: now,
  }).onConflictDoNothing({
    target: [
      schema.postClassNotificationAttempts.deliveryId,
      schema.postClassNotificationAttempts.attemptNumber,
    ],
  }).returning({
    id: schema.postClassNotificationAttempts.id,
    status: schema.postClassNotificationAttempts.status,
    providerMessageId: schema.postClassNotificationAttempts.providerMessageId,
  });
  const [existingAttempt] = createdAttempt ? [] : await db.select({
    id: schema.postClassNotificationAttempts.id,
    status: schema.postClassNotificationAttempts.status,
    providerMessageId: schema.postClassNotificationAttempts.providerMessageId,
  }).from(schema.postClassNotificationAttempts).where(and(
    eq(schema.postClassNotificationAttempts.deliveryId, deliveryId),
    eq(schema.postClassNotificationAttempts.attemptNumber, attemptNumber),
  )).limit(1);
  const attempt = createdAttempt ?? existingAttempt;
  if (!attempt) return "skipped";
  if (attempt.status === "sent") {
    await db.update(schema.postClassNotificationDeliveries).set({
      status: "sent",
      provider: senderKey,
      providerMessageId: attempt.providerMessageId,
      sentAt: now,
      nextAttemptAt: null,
      finalError: null,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassNotificationDeliveries.id, deliveryId),
      eq(schema.postClassNotificationDeliveries.status, "sending"),
      eq(schema.postClassNotificationDeliveries.attemptCount, attemptNumber),
    ));
    await refreshRunCounts(db, claimed.runId);
    return "sent";
  }

  let sent: { id: string };
  try {
    sent = await sender.sendEmail({
      to: claimed.recipientEmail,
      subject: claimed.subject,
      text: content.text,
      html: content.html,
      // Keep one provider key across retries so a relay success followed by a
      // local persistence failure cannot create a second tutor email.
      idempotencyKey: claimed.idempotencyKey,
    });
  } catch (error) {
    const safe = safeEmailError(error);
    const retryIndex = attemptNumber - 1;
    const nextAttemptAt = attemptNumber < MAX_ATTEMPTS
      ? new Date(now.getTime() + RETRY_BACKOFF_MINUTES[retryIndex] * 60_000)
      : null;
    await withPostClassTransaction(db, async (tx) => {
      await tx.update(schema.postClassNotificationAttempts).set({
        status: "failed",
        errorCode: safe.code,
        errorMessage: safe.message,
        finishedAt: new Date(),
      }).where(and(
        eq(schema.postClassNotificationAttempts.id, attempt.id),
        eq(schema.postClassNotificationAttempts.status, "sending"),
      ));
      await tx.update(schema.postClassNotificationDeliveries).set({
        status: "failed",
        provider: senderKey,
        nextAttemptAt,
        finalError: attemptNumber >= MAX_ATTEMPTS ? safe.message : null,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.postClassNotificationDeliveries.id, deliveryId),
        eq(schema.postClassNotificationDeliveries.status, "sending"),
        eq(schema.postClassNotificationDeliveries.attemptCount, attemptNumber),
      ));
    });
    await refreshRunCounts(db, claimed.runId);
    return "failed";
  }

  // Keep provider success separate from persistence errors. If this atomic
  // write fails, the delivery remains `sending`; stale recovery reuses this
  // exact attempt/provider/key instead of failing over and risking a duplicate.
  await withPostClassTransaction(db, async (tx) => {
    await tx.update(schema.postClassNotificationAttempts).set({
      status: "sent",
      providerMessageId: sent.id,
      finishedAt: new Date(),
    }).where(eq(schema.postClassNotificationAttempts.id, attempt.id));
    await tx.update(schema.postClassNotificationDeliveries).set({
      status: "sent",
      provider: senderKey,
      providerMessageId: sent.id,
      sentAt: new Date(),
      nextAttemptAt: null,
      finalError: null,
      updatedAt: new Date(),
    }).where(eq(schema.postClassNotificationDeliveries.id, deliveryId));
  });
  await refreshRunCounts(db, claimed.runId);
  return "sent";
}

export async function runPostClassReminder(
  kind: ReminderKind,
  options: { now?: Date; db?: Database; senders?: PostClassNotificationSenders } = {},
): Promise<PostClassReminderResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const created = await createReminderRun(db, kind, now);
  const senders = options.senders ?? defaultSenders();
  const outcomes = await Promise.all(created.deliveryIds.map((id) => attemptDelivery(db, id, senders, now)));
  return {
    runId: created.runId,
    duplicate: created.duplicate,
    eligible: created.eligible,
    deliveries: created.deliveryIds.length,
    sent: outcomes.filter((value) => value === "sent").length,
    failed: outcomes.filter((value) => value === "failed").length,
    cancelled: outcomes.filter((value) => value === "cancelled").length,
    unresolvedRecipients: created.unresolved,
  };
}

export async function processDuePostClassNotificationRetries(
  options: { now?: Date; limit?: number; db?: Database; senders?: PostClassNotificationSenders } = {},
) {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const rows = await db.select({ id: schema.postClassNotificationDeliveries.id })
    .from(schema.postClassNotificationDeliveries)
    .where(or(
      and(
        eq(schema.postClassNotificationDeliveries.status, "pending"),
        or(
          isNull(schema.postClassNotificationDeliveries.nextAttemptAt),
          lte(schema.postClassNotificationDeliveries.nextAttemptAt, now),
        ),
      ),
      and(
        eq(schema.postClassNotificationDeliveries.status, "failed"),
        isNotNull(schema.postClassNotificationDeliveries.nextAttemptAt),
        lte(schema.postClassNotificationDeliveries.nextAttemptAt, now),
      ),
      and(
        eq(schema.postClassNotificationDeliveries.status, "sending"),
        lte(schema.postClassNotificationDeliveries.updatedAt, new Date(now.getTime() - SENDING_STALE_MS)),
      ),
    )).orderBy(asc(schema.postClassNotificationDeliveries.nextAttemptAt)).limit(limit);
  const senders = options.senders ?? defaultSenders();
  const outcomes = await Promise.all(rows.map((row) => attemptDelivery(db, row.id, senders, now)));
  return {
    considered: rows.length,
    sent: outcomes.filter((value) => value === "sent").length,
    failed: outcomes.filter((value) => value === "failed").length,
    cancelled: outcomes.filter((value) => value === "cancelled").length,
    deferred: outcomes.filter((value) => value === "deferred").length,
  };
}

export async function sendPostClassAdminDigest(
  options: { now?: Date; db?: Database; senders?: PostClassNotificationSenders } = {},
) {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const key = buildPostClassNotificationKey(["admin_digest", bangkokDate(now)]);
  const established = await withPostClassTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [createdRun] = await tx.insert(schema.postClassNotificationRuns).values({
      kind: "admin_digest",
      status: "pending",
      scheduledFor: now,
      idempotencyKey: key,
      startedAt: now,
    }).onConflictDoNothing({ target: schema.postClassNotificationRuns.idempotencyKey }).returning();
    const [existingRun] = createdRun ? [] : await tx.select()
      .from(schema.postClassNotificationRuns)
      .where(eq(schema.postClassNotificationRuns.idempotencyKey, key))
      .limit(1);
    const run = createdRun ?? existingRun;
    if (!run) throw new Error("Could not establish a durable admin-digest run.");
    const recipients = await loadActiveDigestRecipients(tx);
    const activeRecipientSet = new Set(recipients);
    const priorDeliveries = await tx.select({
      id: schema.postClassNotificationDeliveries.id,
      recipientEmail: schema.postClassNotificationDeliveries.recipientEmail,
      status: schema.postClassNotificationDeliveries.status,
    }).from(schema.postClassNotificationDeliveries)
      .where(eq(schema.postClassNotificationDeliveries.runId, run.id));
    const obsoleteIds = priorDeliveries.flatMap((delivery) => {
      const email = normalizeEmail(delivery.recipientEmail);
      return delivery.status !== "sent" && delivery.status !== "cancelled" &&
        (!email || !activeRecipientSet.has(email))
        ? [delivery.id]
        : [];
    });
    if (obsoleteIds.length > 0) {
      await tx.update(schema.postClassNotificationDeliveries).set({
        status: "cancelled",
        cancelledAt: now,
        nextAttemptAt: null,
        updatedAt: now,
      }).where(inArray(schema.postClassNotificationDeliveries.id, obsoleteIds));
    }

    const digest = await adminDigestContent(tx, now);
    const deliveryIds: string[] = [];
    for (const email of recipients) {
      const idempotencyKey = buildPostClassNotificationKey(["admin_digest", bangkokDate(now), email]);
      const [createdDelivery] = await tx.insert(schema.postClassNotificationDeliveries).values({
        runId: run.id,
        recipientEmail: email,
        subject: `Post-class feedback daily digest — ${bangkokDate(now)}`,
        status: "pending",
        idempotencyKey,
        nextAttemptAt: now,
      }).onConflictDoNothing({ target: schema.postClassNotificationDeliveries.idempotencyKey }).returning({ id: schema.postClassNotificationDeliveries.id });
      const [existingDelivery] = createdDelivery ? [] : await tx.select({ id: schema.postClassNotificationDeliveries.id })
        .from(schema.postClassNotificationDeliveries)
        .where(eq(schema.postClassNotificationDeliveries.idempotencyKey, idempotencyKey))
        .limit(1);
      const deliveryId = createdDelivery?.id ?? existingDelivery?.id;
      if (deliveryId) deliveryIds.push(deliveryId);
    }
    const deliveryStates = await tx.select({
      status: schema.postClassNotificationDeliveries.status,
      attemptCount: schema.postClassNotificationDeliveries.attemptCount,
      nextAttemptAt: schema.postClassNotificationDeliveries.nextAttemptAt,
    }).from(schema.postClassNotificationDeliveries)
      .where(eq(schema.postClassNotificationDeliveries.runId, run.id));
    const summary = summarizePostClassNotificationRun(deliveryStates);
    await tx.update(schema.postClassNotificationRuns).set({
      status: summary.status,
      eligibleCount: recipients.length,
      deliveryCount: deliveryStates.length,
      sentCount: summary.sent,
      failedCount: summary.failed,
      cancelledCount: summary.cancelled,
      metadata: digest.metadata,
      finishedAt: summary.active ? null : new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.postClassNotificationRuns.id, run.id));
    return { duplicate: !createdRun, deliveryIds };
  });
  const senders = options.senders ?? defaultSenders();
  const outcomes = await Promise.all(established.deliveryIds.map((id) => attemptDelivery(db, id, senders, now)));
  return {
    duplicate: established.duplicate,
    sent: outcomes.filter((value) => value === "sent").length,
    failed: outcomes.filter((value) => value === "failed").length,
  };
}

export async function sendPostClassTestEmail(
  actorEmail: string,
  recipientEmail: string,
  db: Database = getDb(),
  sender: ScheduleEmailSender = createAppsScriptScheduleEmailSender("primary"),
) {
  const recipient = normalizeEmail(recipientEmail);
  if (!recipient) throw new PostClassValidationError("A valid test recipient email is required.");
  const nonce = createHash("sha256").update(`${actorEmail}:${recipient}:${Date.now()}`).digest("hex").slice(0, 20);
  const sent = await sender.sendEmail({
    to: recipient,
    subject: "Post-class feedback email test",
    text: `Email delivery for the post-class feedback workspace is working.\n\n${WORKSPACE_URL}`,
    html: `<p>Email delivery for the post-class feedback workspace is working.</p><p><a href="${WORKSPACE_URL}">Open the workspace</a></p>`,
    idempotencyKey: buildPostClassNotificationKey(["test", nonce]),
  });
  const now = new Date();
  await Promise.all([
    db.update(schema.postClassSettings).set({
      emailDeliveryVerifiedAt: now,
      version: sql`${schema.postClassSettings.version} + 1`,
      updatedByEmail: actorEmail,
      updatedAt: now,
    }).where(eq(schema.postClassSettings.id, "default")),
    db.insert(schema.postClassConfigAuditLog).values({
      entityType: "email_delivery",
      entityKey: recipient,
      action: "test_succeeded",
      actorEmail,
      afterValue: { recipient, providerMessageId: sent.id },
    }),
  ]);
  return { ok: true, recipient, providerMessageId: sent.id };
}
