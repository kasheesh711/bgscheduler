// Progress Tests — teacher heads-up email (fired from sync at count == 6).
//
// For each newly-approaching enrollment, resolve the most-frequent tutor's
// canonical key to a contact email (onsiteEmail, then onlineEmail fallback) and
// send a single heads-up email carrying the AI summary block (or a graceful
// fallback when no summary is available). Tracking is idempotent per cycle via
// progress_test_email_runs + progress_test_notifications keyed on
// `progress-test:teacher:{enrollmentKey}:{cycleIndex}`, upserted with
// onConflictDoUpdate so a failed send retries to success on a later run. On a
// successful send the enrollment's cycle state is stamped teacherNotifiedAt +
// teacherNotifiedForCycle so the engine never re-notifies for the same cycle.
//
// Mirrors the once-per-recipient idempotent pattern in
// src/lib/leave-requests/sync.ts (sendNewRequestNotifications) and reuses
// createAppsScriptScheduleEmailSender() like src/lib/classrooms/admin-schedule-email.ts.
//
// Fire-and-forget safe: a send failure is recorded and never thrown out of this
// module (a per-enrollment error must not abort the sync run). Never log the AI
// summary, recipient PII, or any feedback text — only counts + error messages.

import { eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { APP_BASE_URL } from "@/lib/leave-requests/config";
import {
  createAppsScriptScheduleEmailSender,
  type ScheduleEmailSender,
} from "@/lib/classrooms/schedule-email";
import { PROGRESS_TEST_THRESHOLD } from "./config";
import type { ProgressTestAiSummary } from "./types";

const TEACHER_HEADS_UP_ACTOR = "cron@progress-test-teacher-heads-up";

/** One newly-approaching enrollment to notify its most-frequent teacher about. */
export interface TeacherHeadsUpEnrollment {
  enrollmentKey: string;
  cycleIndex: number;
  studentName: string;
  subject: string;
  currentCount: number;
  mostFrequentTutorCanonicalKey: string | null;
  mostFrequentTutorDisplayName: string | null;
  aiSummary: ProgressTestAiSummary | null;
}

/** Inputs for runTeacherHeadsUpNotifications — explicit deps for unit testing. */
export interface TeacherHeadsUpInput {
  syncRunId: string;
  enrollments: TeacherHeadsUpEnrollment[];
  sender?: ScheduleEmailSender;
}

/** Per-enrollment outcome of the heads-up attempt. */
export interface TeacherHeadsUpOutcome {
  enrollmentKey: string;
  cycleIndex: number;
  status: "sent" | "failed" | "unresolved";
  recipientEmail: string | null;
  error: string | null;
}

/** Aggregate result returned to the sync caller (recorded on the run row). */
export interface TeacherHeadsUpResult {
  attempted: number;
  sent: number;
  failed: number;
  unresolved: number;
  outcomes: TeacherHeadsUpOutcome[];
}

/** Escapes the five HTML-significant characters in interpolated email fields. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Builds the per-cycle idempotency key shared by the email run + notification. */
function idempotencyKeyFor(enrollmentKey: string, cycleIndex: number): string {
  return `progress-test:teacher:${enrollmentKey}:${cycleIndex}`;
}

/** Trims and normalizes the progress-tests dashboard URL (no trailing slash). */
function dashboardUrl(): string {
  return `${APP_BASE_URL.replace(/\/$/, "")}/progress-tests`;
}

/**
 * Resolves the most-frequent tutor's contact email for an enrollment.
 *
 * Prefers the onsite email, falling back to the online email, mirroring the
 * teacher-email recipient rule used elsewhere (the schedule-email preview reads
 * tutorContacts.onsiteEmail; here we additionally fall back to onlineEmail so a
 * fully-remote tutor is still reachable). Inactive contacts are ignored.
 *
 * @returns the trimmed recipient email, or null when none can be resolved.
 */
async function resolveTeacherEmail(
  db: Database,
  canonicalKey: string,
): Promise<string | null> {
  const [contact] = await db
    .select({
      onsiteEmail: schema.tutorContacts.onsiteEmail,
      onlineEmail: schema.tutorContacts.onlineEmail,
      active: schema.tutorContacts.active,
    })
    .from(schema.tutorContacts)
    .where(eq(schema.tutorContacts.canonicalKey, canonicalKey))
    .limit(1);

  if (!contact || !contact.active) return null;
  return contact.onsiteEmail?.trim() || contact.onlineEmail?.trim() || null;
}

/** Renders the AI summary block (plain text), or a graceful fallback line. */
function renderSummaryText(summary: ProgressTestAiSummary | null): string[] {
  if (!summary) {
    return [
      "AI summary: not enough recent feedback — please review recent classes before the test.",
    ];
  }
  const lines = [`AI summary: ${summary.headline}`];
  if (summary.strengths.length > 0) {
    lines.push("Strengths:", ...summary.strengths.map((item) => `- ${item}`));
  }
  if (summary.focusAreas.length > 0) {
    lines.push("Focus areas:", ...summary.focusAreas.map((item) => `- ${item}`));
  }
  if (summary.recommendation.trim()) {
    lines.push(`Recommendation: ${summary.recommendation}`);
  }
  return lines;
}

/** Renders the AI summary block (HTML), or a graceful fallback paragraph. */
function renderSummaryHtml(summary: ProgressTestAiSummary | null): string {
  if (!summary) {
    return `<p style="margin:0 0 16px;color:#475569;">We do not have enough recent feedback to summarize automatically — please review the student's recent classes before the test.</p>`;
  }
  const blocks = [
    `<p style="margin:0 0 12px;"><strong>${escapeHtml(summary.headline)}</strong></p>`,
  ];
  if (summary.strengths.length > 0) {
    blocks.push(
      `<p style="margin:0 0 4px;color:#475569;">Strengths</p><ul style="margin:0 0 12px;">${summary.strengths
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")}</ul>`,
    );
  }
  if (summary.focusAreas.length > 0) {
    blocks.push(
      `<p style="margin:0 0 4px;color:#475569;">Focus areas</p><ul style="margin:0 0 12px;">${summary.focusAreas
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")}</ul>`,
    );
  }
  if (summary.recommendation.trim()) {
    blocks.push(
      `<p style="margin:0 0 12px;color:#475569;">Recommendation: ${escapeHtml(summary.recommendation)}</p>`,
    );
  }
  return blocks.join("");
}

/** Builds the heads-up email subject for an enrollment. */
function buildSubject(enrollment: TeacherHeadsUpEnrollment): string {
  return `[BeGifted] Progress test coming up for ${enrollment.studentName} (${enrollment.subject || "class"})`;
}

/** Builds the plain-text heads-up email body. */
function buildText(enrollment: TeacherHeadsUpEnrollment): string {
  const cyclePosition = `${enrollment.currentCount} of ${PROGRESS_TEST_THRESHOLD}`;
  return [
    `Hi ${enrollment.mostFrequentTutorDisplayName ?? "there"},`,
    "",
    `${enrollment.studentName} is approaching a progress test in ${enrollment.subject || "their class"} (class ${cyclePosition} this cycle). Please let the student know a progress test is coming up after the next class so they can prepare.`,
    "",
    ...renderSummaryText(enrollment.aiSummary),
    "",
    `Student: ${enrollment.studentName}`,
    `Subject: ${enrollment.subject || "class"}`,
    `Cycle progress: ${cyclePosition}`,
    "",
    `Open Progress Tests: ${dashboardUrl()}`,
  ].join("\n");
}

/** Builds the HTML heads-up email body. */
function buildHtml(enrollment: TeacherHeadsUpEnrollment): string {
  const cyclePosition = `${enrollment.currentCount} of ${PROGRESS_TEST_THRESHOLD}`;
  return `
    <div style="font-family:Inter,Arial,sans-serif;color:#0f172a;max-width:640px">
      <h2 style="margin:0 0 12px">Progress test coming up</h2>
      <p style="margin:0 0 16px;color:#475569;">Hi ${escapeHtml(enrollment.mostFrequentTutorDisplayName ?? "there")}, <strong>${escapeHtml(enrollment.studentName)}</strong> is approaching a progress test in <strong>${escapeHtml(enrollment.subject || "their class")}</strong> (class ${escapeHtml(cyclePosition)} this cycle). Please let the student know a progress test is coming up after the next class so they can prepare.</p>
      ${renderSummaryHtml(enrollment.aiSummary)}
      <ul style="margin:0 0 16px;color:#0f172a;">
        <li>Student: ${escapeHtml(enrollment.studentName)}</li>
        <li>Subject: ${escapeHtml(enrollment.subject || "class")}</li>
        <li>Cycle progress: ${escapeHtml(cyclePosition)}</li>
      </ul>
      <p><a href="${dashboardUrl()}">Open Progress Tests dashboard</a></p>
    </div>
  `;
}

/**
 * Upserts the per-cycle email-run row, returning its id.
 *
 * Keyed by the per-cycle idempotency key so a retry reuses the same run row and
 * accumulates attempt counters rather than creating duplicates.
 *
 * @returns the email-run id to link the notification + outcome to.
 */
async function upsertEmailRun(
  db: Database,
  input: {
    enrollmentKey: string;
    cycleIndex: number;
    subject: string;
    idempotencyKey: string;
    status: "sent" | "failed";
    error: string | null;
  },
): Promise<string> {
  const now = new Date();
  const [run] = await db
    .insert(schema.progressTestEmailRuns)
    .values({
      enrollmentKey: input.enrollmentKey,
      cycleIndex: input.cycleIndex,
      status: input.status,
      subject: input.subject,
      idempotencyKey: input.idempotencyKey,
      triggerKind: "approaching",
      createdBy: TEACHER_HEADS_UP_ACTOR,
      attemptedCount: 1,
      successCount: input.status === "sent" ? 1 : 0,
      failedCount: input.status === "sent" ? 0 : 1,
      lastError: input.error,
      sentAt: input.status === "sent" ? now : null,
    })
    .onConflictDoUpdate({
      target: schema.progressTestEmailRuns.idempotencyKey,
      set: {
        status: input.status,
        attemptedCount: sql`${schema.progressTestEmailRuns.attemptedCount} + 1`,
        successCount:
          input.status === "sent"
            ? sql`${schema.progressTestEmailRuns.successCount} + 1`
            : sql`${schema.progressTestEmailRuns.successCount}`,
        failedCount:
          input.status === "sent"
            ? sql`${schema.progressTestEmailRuns.failedCount}`
            : sql`${schema.progressTestEmailRuns.failedCount} + 1`,
        lastError: input.error,
        sentAt: input.status === "sent" ? now : sql`${schema.progressTestEmailRuns.sentAt}`,
        updatedAt: now,
      },
    })
    .returning({ id: schema.progressTestEmailRuns.id });
  return run.id;
}

/**
 * Sends the heads-up email for a single enrollment and records its outcome.
 *
 * 1. Resolve the recipient email; unresolved → record an `unresolved` notification
 *    row (no email-run, teacherNotifiedAt stays null) and return early.
 * 2. Attempt the send (idempotent via the per-cycle idempotency key).
 * 3. Upsert the email-run + notification with onConflictDoUpdate so a failed send
 *    can retry to success on a later run.
 * 4. On success, stamp the cycle state teacherNotifiedAt + teacherNotifiedForCycle.
 *
 * @returns the per-enrollment outcome (never throws).
 */
async function notifyEnrollment(
  db: Database,
  enrollment: TeacherHeadsUpEnrollment,
  sender: ScheduleEmailSender,
): Promise<TeacherHeadsUpOutcome> {
  const idempotencyKey = idempotencyKeyFor(enrollment.enrollmentKey, enrollment.cycleIndex);

  const canonicalKey = enrollment.mostFrequentTutorCanonicalKey?.trim() || null;
  const email = canonicalKey ? await resolveTeacherEmail(db, canonicalKey) : null;

  if (!email) {
    const error = canonicalKey
      ? `No contact email for tutor "${canonicalKey}"`
      : "No most-frequent tutor resolved for this enrollment";
    await db
      .insert(schema.progressTestNotifications)
      .values({
        emailRunId: null,
        enrollmentKey: enrollment.enrollmentKey,
        cycleIndex: enrollment.cycleIndex,
        notificationType: "teacher_heads_up_email",
        recipientEmail: canonicalKey ? `unresolved:${canonicalKey}` : "unresolved",
        status: "unresolved",
        error,
        idempotencyKey,
      })
      .onConflictDoUpdate({
        target: schema.progressTestNotifications.idempotencyKey,
        set: { status: "unresolved", error },
      });
    return {
      enrollmentKey: enrollment.enrollmentKey,
      cycleIndex: enrollment.cycleIndex,
      status: "unresolved",
      recipientEmail: null,
      error,
    };
  }

  const subject = buildSubject(enrollment);
  let providerMessageId: string | null = null;
  let error: string | null = null;
  try {
    const sent = await sender.sendEmail({
      to: email,
      subject,
      html: buildHtml(enrollment),
      text: buildText(enrollment),
      idempotencyKey,
    });
    providerMessageId = sent.id;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Teacher heads-up email failed";
  }

  const status: "sent" | "failed" = error ? "failed" : "sent";
  const emailRunId = await upsertEmailRun(db, {
    enrollmentKey: enrollment.enrollmentKey,
    cycleIndex: enrollment.cycleIndex,
    subject,
    idempotencyKey,
    status,
    error,
  });

  await db
    .insert(schema.progressTestNotifications)
    .values({
      emailRunId,
      enrollmentKey: enrollment.enrollmentKey,
      cycleIndex: enrollment.cycleIndex,
      notificationType: "teacher_heads_up_email",
      recipientEmail: email,
      status,
      providerMessageId,
      error,
      idempotencyKey,
      sentAt: error ? null : new Date(),
    })
    .onConflictDoUpdate({
      target: schema.progressTestNotifications.idempotencyKey,
      set: {
        emailRunId,
        recipientEmail: email,
        status,
        providerMessageId,
        error,
        sentAt: error ? null : new Date(),
      },
    });

  if (!error) {
    await db
      .update(schema.progressTestCycleState)
      .set({
        teacherNotifiedAt: new Date(),
        teacherNotifiedForCycle: enrollment.cycleIndex,
        updatedAt: new Date(),
      })
      .where(eq(schema.progressTestCycleState.enrollmentKey, enrollment.enrollmentKey));
  }

  return {
    enrollmentKey: enrollment.enrollmentKey,
    cycleIndex: enrollment.cycleIndex,
    status,
    recipientEmail: email,
    error,
  };
}

/**
 * Sends teacher heads-up emails for newly-approaching enrollments (idempotent).
 *
 * 1. Default the sender to the Apps Script sender (overridable for tests).
 * 2. For each enrollment, resolve the tutor email and send (or record an
 *    `unresolved` row when no contact email can be found), upserting the email-run
 *    + notification on the per-cycle idempotency key so a failed send retries to
 *    success on a later run.
 * 3. On a successful send, stamp the cycle state teacherNotifiedAt +
 *    teacherNotifiedForCycle so the engine never re-notifies this cycle.
 *
 * Fire-and-forget safe: each enrollment is isolated in a try/catch so one failure
 * never aborts the rest, and the function never throws out of itself.
 *
 * @returns aggregate sent/failed/unresolved counts plus per-enrollment outcomes.
 */
export async function runTeacherHeadsUpNotifications(
  db: Database = getDb(),
  input: TeacherHeadsUpInput,
): Promise<TeacherHeadsUpResult> {
  const sender = input.sender ?? createAppsScriptScheduleEmailSender();
  const outcomes: TeacherHeadsUpOutcome[] = [];

  for (const enrollment of input.enrollments) {
    try {
      outcomes.push(await notifyEnrollment(db, enrollment, sender));
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : "Teacher heads-up notification failed";
      console.error(
        `progress-test teacher heads-up failed (enrollment=${enrollment.enrollmentKey}, cycle=${enrollment.cycleIndex}): ${error}`,
      );
      outcomes.push({
        enrollmentKey: enrollment.enrollmentKey,
        cycleIndex: enrollment.cycleIndex,
        status: "failed",
        recipientEmail: null,
        error,
      });
    }
  }

  return {
    attempted: outcomes.length,
    sent: outcomes.filter((outcome) => outcome.status === "sent").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    unresolved: outcomes.filter((outcome) => outcome.status === "unresolved").length,
    outcomes,
  };
}
