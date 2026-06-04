// Progress Tests — once-daily admin digest to all admin_users.
//
// Lists students newly approaching a progress test, students that are due but
// have no booked test yet, and an "Action needed" section of teacher heads-up
// emails that could not be resolved (so an admin can fix the tutor contact or
// notify the teacher manually). Recipients are every admin_users row.
//
// Once-per-day idempotency via progress_test_admin_digest_runs, keyed on
// `progress-test-digest:{digestDate}` (digestDate = todayBangkok). Mirrors the
// classroom admin digest in src/lib/classrooms/admin-schedule-email.ts: a
// terminal run row (sent/partial/failed) for the date short-circuits a re-run,
// and per-recipient outcomes are tracked in progress_test_admin_digest_recipients
// with a per-recipient Apps Script idempotency key. If there is nothing to
// report, the send is skipped and a terminal `skipped` run row is recorded.
//
// Never log recipient PII, the AI summary, or any feedback text.

import { eq, inArray } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { todayBangkok } from "@/lib/room-capacity/dates";
import {
  createAppsScriptScheduleEmailSender,
  type ScheduleEmailSender,
} from "@/lib/classrooms/schedule-email";
import { APP_BASE_URL } from "@/lib/leave-requests/config";
import { PROGRESS_TEST_THRESHOLD } from "./config";

const ADMIN_DIGEST_ACTOR = "cron@progress-test-admin-digest";

/** Outcome of one admin-digest pass, surfaced in the route response + audit. */
export interface ProgressTestAdminDigestResult {
  status: "sent" | "partial" | "failed" | "skipped";
  digestDate: string;
  digestRunId: string | null;
  approachingCount: number;
  dueCount: number;
  unresolvedCount: number;
  attempted: number;
  success: number;
  failed: number;
  message: string;
}

/** One student row in the digest (approaching or due). */
interface DigestStudentRow {
  studentName: string;
  subject: string;
  currentCount: number;
  tutorDisplayName: string | null;
}

/** Aggregated content the digest reports on. */
interface DigestContent {
  approaching: DigestStudentRow[];
  due: DigestStudentRow[];
  unresolvedEmails: string[];
}

/** Escapes the five HTML-significant characters in interpolated digest fields. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Trims and normalizes the progress-tests dashboard URL (no trailing slash). */
function dashboardUrl(): string {
  return `${APP_BASE_URL.replace(/\/$/, "")}/progress-tests`;
}

/**
 * Loads every admin_users email, lowercased, de-duplicated, and sorted.
 *
 * Mirrors loadAdminEmails in src/lib/classrooms/admin-schedule-email.ts so the
 * digest reaches the same admin allowlist used elsewhere.
 *
 * @returns the sorted, unique admin recipient emails.
 */
async function loadAdminEmails(db: Database): Promise<string[]> {
  const rows = await db
    .select({ email: schema.adminUsers.email })
    .from(schema.adminUsers);
  return [...new Set(rows.map((row) => row.email.trim().toLowerCase()).filter(Boolean))].sort();
}

/**
 * Builds the digest content from current cycle state + unresolved notifications.
 *
 * 1. Read cycle-state rows whose status is `approaching` or `due`.
 * 2. Split into approaching vs due, treating only un-booked due rows as
 *    actionable (a due row with a booked test is already handled → excluded).
 * 3. Collect distinct recipient emails of `unresolved` teacher notifications so
 *    admins can fix the contact or notify the teacher manually.
 *
 * @returns the approaching/due student rows plus unresolved teacher emails.
 */
async function buildDigestContent(db: Database): Promise<DigestContent> {
  const cycleRows = await db
    .select({
      studentName: schema.progressTestCycleState.studentName,
      subject: schema.progressTestCycleState.subject,
      currentCount: schema.progressTestCycleState.currentCount,
      status: schema.progressTestCycleState.status,
      bookedTestWiseSessionId: schema.progressTestCycleState.bookedTestWiseSessionId,
      tutorDisplayName: schema.progressTestCycleState.mostFrequentTutorDisplayName,
    })
    .from(schema.progressTestCycleState)
    .where(inArray(schema.progressTestCycleState.status, ["approaching", "due"]));

  const approaching: DigestStudentRow[] = [];
  const due: DigestStudentRow[] = [];
  for (const row of cycleRows) {
    const studentRow: DigestStudentRow = {
      studentName: row.studentName,
      subject: row.subject,
      currentCount: row.currentCount,
      tutorDisplayName: row.tutorDisplayName,
    };
    if (row.status === "approaching") {
      approaching.push(studentRow);
    } else if (row.status === "due" && !row.bookedTestWiseSessionId) {
      due.push(studentRow);
    }
  }

  const unresolvedRows = await db
    .select({ recipientEmail: schema.progressTestNotifications.recipientEmail })
    .from(schema.progressTestNotifications)
    .where(eq(schema.progressTestNotifications.status, "unresolved"));
  const unresolvedEmails = [
    ...new Set(unresolvedRows.map((row) => row.recipientEmail).filter(Boolean)),
  ].sort();

  return { approaching, due, unresolvedEmails };
}

/** Whether the digest has anything worth sending. */
function hasReportableContent(content: DigestContent): boolean {
  return (
    content.approaching.length > 0 ||
    content.due.length > 0 ||
    content.unresolvedEmails.length > 0
  );
}

/** One plain-text line describing a student row. */
function studentLine(row: DigestStudentRow): string {
  const teacher = row.tutorDisplayName ?? "tutor needs review";
  return `- ${row.studentName} (${row.subject || "class"}) - ${row.currentCount} of ${PROGRESS_TEST_THRESHOLD} classes - ${teacher}`;
}

/** Renders the plain-text digest body. */
function renderText(digestDate: string, content: DigestContent): string {
  const lines = [`BeGifted progress tests - ${digestDate}`, ""];

  lines.push(`Approaching a progress test (${content.approaching.length}):`);
  lines.push(
    ...(content.approaching.length > 0
      ? content.approaching.map(studentLine)
      : ["- None"]),
    "",
  );

  lines.push(`Due, not yet booked (${content.due.length}):`);
  lines.push(
    ...(content.due.length > 0 ? content.due.map(studentLine) : ["- None"]),
    "",
  );

  if (content.unresolvedEmails.length > 0) {
    lines.push(
      "Action needed - teacher heads-up could not be sent (resolve the tutor contact or notify the teacher manually):",
      ...content.unresolvedEmails.map((email) => `- ${email}`),
      "",
    );
  }

  lines.push(`Open Progress Tests: ${dashboardUrl()}`);
  return lines.join("\n");
}

/** Renders an HTML list of student rows (or an empty-state line). */
function renderStudentListHtml(rows: DigestStudentRow[]): string {
  if (rows.length === 0) return `<p style="margin:0 0 16px;color:#64748b;">None.</p>`;
  return `<ul style="margin:0 0 16px;">${rows
    .map(
      (row) =>
        `<li><strong>${escapeHtml(row.studentName)}</strong> (${escapeHtml(row.subject || "class")}) - ${row.currentCount} of ${PROGRESS_TEST_THRESHOLD} classes - ${escapeHtml(row.tutorDisplayName ?? "tutor needs review")}</li>`,
    )
    .join("")}</ul>`;
}

/** Renders the HTML digest body. */
function renderHtml(digestDate: string, content: DigestContent): string {
  const actionNeeded =
    content.unresolvedEmails.length > 0
      ? `<h3 style="margin:16px 0 8px;color:#b45309;">Action needed</h3><p style="margin:0 0 8px;color:#475569;">A teacher heads-up could not be sent for the tutors below — resolve the tutor contact or notify the teacher manually.</p><ul style="margin:0 0 16px;">${content.unresolvedEmails
          .map((email) => `<li>${escapeHtml(email)}</li>`)
          .join("")}</ul>`
      : "";
  return `
    <div style="font-family:Inter,Arial,sans-serif;color:#0f172a;max-width:720px">
      <h2 style="margin:0 0 4px">BeGifted progress tests</h2>
      <p style="margin:0 0 16px;color:#475569;">${escapeHtml(digestDate)}</p>
      <h3 style="margin:16px 0 8px;">Approaching a progress test (${content.approaching.length})</h3>
      ${renderStudentListHtml(content.approaching)}
      <h3 style="margin:16px 0 8px;">Due, not yet booked (${content.due.length})</h3>
      ${renderStudentListHtml(content.due)}
      ${actionNeeded}
      <p><a href="${dashboardUrl()}">Open Progress Tests dashboard</a></p>
    </div>
  `;
}

/**
 * Whether an admin-digest run already exists for this date.
 *
 * The digest is once-daily and `progress_test_admin_digest_runs.digest_date` is
 * UNIQUE, so there is at most one run per date and any existing row (sent,
 * partial, failed, or skipped) is terminal for that day — a same-day re-invocation
 * short-circuits rather than sending twice.
 *
 * @returns true when a digest run is already recorded for the date.
 */
async function hasTerminalDigestForDate(db: Database, digestDate: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.progressTestAdminDigestRuns.id })
    .from(schema.progressTestAdminDigestRuns)
    .where(eq(schema.progressTestAdminDigestRuns.digestDate, digestDate))
    .limit(1);
  return rows.length > 0;
}

/**
 * Inserts the per-date digest run row, returning null on a unique-key conflict.
 *
 * The unique idempotency key + unique digest_date index make this the
 * single-flight guard: a concurrent invocation that loses the race gets a 23505
 * and returns null (treated as "already created").
 *
 * @returns the created run row, or null when one already exists for the date.
 */
async function createDigestRun(
  db: Database,
  input: { digestDate: string; subject: string; approachingCount: number; dueCount: number },
): Promise<typeof schema.progressTestAdminDigestRuns.$inferSelect | null> {
  try {
    const [run] = await db
      .insert(schema.progressTestAdminDigestRuns)
      .values({
        digestDate: input.digestDate,
        subject: input.subject,
        idempotencyKey: `progress-test-digest:${input.digestDate}`,
        triggerKind: "daily",
        createdBy: ADMIN_DIGEST_ACTOR,
        approachingCount: input.approachingCount,
        dueCount: input.dueCount,
      })
      .returning();
    return run;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
      return null;
    }
    throw error;
  }
}

/** Sets a terminal status + counts on the digest run row. */
async function finalizeDigestRun(
  db: Database,
  digestRunId: string,
  counts: { attempted: number; success: number; failed: number },
  lastError: string | null,
): Promise<void> {
  const status = counts.failed > 0 ? (counts.success > 0 ? "partial" : "failed") : "sent";
  await db
    .update(schema.progressTestAdminDigestRuns)
    .set({
      status,
      attemptedCount: counts.attempted,
      successCount: counts.success,
      failedCount: counts.failed,
      lastError,
      sentAt: counts.success > 0 ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.progressTestAdminDigestRuns.id, digestRunId));
}

/**
 * Sends the once-daily progress-test admin digest to all admin_users.
 *
 * 1. Short-circuit if a terminal digest run already exists for today (Bangkok).
 * 2. Build the digest content; if there is nothing to report, record a terminal
 *    `skipped` run row and return without sending.
 * 3. Insert the per-date digest run (the unique index is the single-flight guard).
 * 4. Send to every admin recipient with a per-recipient Apps Script idempotency
 *    key, recording each outcome in progress_test_admin_digest_recipients.
 * 5. Finalize the run row (sent/partial/failed) with the per-recipient counts.
 *
 * @returns the digest outcome (status + counts); never throws out (the route
 *   wrapper surfaces unexpected errors, but the happy/empty/skip paths are clean).
 */
export async function sendProgressTestAdminDigest(
  db: Database = getDb(),
  now: Date = new Date(),
  options: { sender?: ScheduleEmailSender } = {},
): Promise<ProgressTestAdminDigestResult> {
  const digestDate = todayBangkok(now);

  if (await hasTerminalDigestForDate(db, digestDate)) {
    return {
      status: "skipped",
      digestDate,
      digestRunId: null,
      approachingCount: 0,
      dueCount: 0,
      unresolvedCount: 0,
      attempted: 0,
      success: 0,
      failed: 0,
      message: "Progress test admin digest already recorded for this date.",
    };
  }

  const content = await buildDigestContent(db);

  if (!hasReportableContent(content)) {
    const run = await createDigestRun(db, {
      digestDate,
      subject: `BeGifted progress tests - ${digestDate}`,
      approachingCount: 0,
      dueCount: 0,
    });
    if (run) {
      await db
        .update(schema.progressTestAdminDigestRuns)
        .set({ status: "skipped", updatedAt: new Date() })
        .where(eq(schema.progressTestAdminDigestRuns.id, run.id));
    }
    return {
      status: "skipped",
      digestDate,
      digestRunId: run?.id ?? null,
      approachingCount: 0,
      dueCount: 0,
      unresolvedCount: 0,
      attempted: 0,
      success: 0,
      failed: 0,
      message: "Nothing to report for the progress test admin digest.",
    };
  }

  const subject = `BeGifted progress tests - ${digestDate} (${content.approaching.length} approaching, ${content.due.length} due)`;
  const run = await createDigestRun(db, {
    digestDate,
    subject,
    approachingCount: content.approaching.length,
    dueCount: content.due.length,
  });
  if (!run) {
    return {
      status: "skipped",
      digestDate,
      digestRunId: null,
      approachingCount: content.approaching.length,
      dueCount: content.due.length,
      unresolvedCount: content.unresolvedEmails.length,
      attempted: 0,
      success: 0,
      failed: 0,
      message: "Progress test admin digest was already created concurrently.",
    };
  }

  const recipients = await loadAdminEmails(db);
  const sender = options.sender ?? createAppsScriptScheduleEmailSender();
  const html = renderHtml(digestDate, content);
  const text = renderText(digestDate, content);
  const counts = { attempted: 0, success: 0, failed: 0 };
  let lastError: string | null = null;

  if (recipients.length === 0) {
    await finalizeDigestRun(db, run.id, { attempted: 0, success: 0, failed: 1 }, "No admin_users email recipients are configured.");
    return {
      status: "failed",
      digestDate,
      digestRunId: run.id,
      approachingCount: content.approaching.length,
      dueCount: content.due.length,
      unresolvedCount: content.unresolvedEmails.length,
      attempted: 0,
      success: 0,
      failed: 1,
      message: "No admin_users email recipients are configured.",
    };
  }

  for (const email of recipients) {
    counts.attempted += 1;
    try {
      const sent = await sender.sendEmail({
        to: email,
        subject,
        html,
        text,
        idempotencyKey: `progress-test-digest:${digestDate}:${email}`,
      });
      counts.success += 1;
      await db.insert(schema.progressTestAdminDigestRecipients).values({
        digestRunId: run.id,
        digestDate,
        recipientEmail: email,
        status: "sent",
        providerMessageId: sent.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Progress test admin digest email failed";
      counts.failed += 1;
      lastError = message;
      await db.insert(schema.progressTestAdminDigestRecipients).values({
        digestRunId: run.id,
        digestDate,
        recipientEmail: email,
        status: "failed",
        error: message,
      });
    }
  }

  await finalizeDigestRun(db, run.id, counts, lastError);
  const status = counts.failed > 0 ? (counts.success > 0 ? "partial" : "failed") : "sent";
  return {
    status,
    digestDate,
    digestRunId: run.id,
    approachingCount: content.approaching.length,
    dueCount: content.due.length,
    unresolvedCount: content.unresolvedEmails.length,
    attempted: counts.attempted,
    success: counts.success,
    failed: counts.failed,
    message: `Progress test admin digest ${status}.`,
  };
}
