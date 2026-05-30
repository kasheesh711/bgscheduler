import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { todayBangkok } from "@/lib/room-capacity/dates";
import {
  getClassroomAssignmentForDate,
  type ClassroomAssignmentDetail,
  type ClassroomRow,
  type ClassroomPublishJob,
} from "./data";
import {
  createAppsScriptScheduleEmailSender,
  type ScheduleEmailSender,
} from "./schedule-email";
import { REMOTE_NO_ROOM_NEEDED } from "./assignment-engine";

const ADMIN_EMAIL_ACTOR = "cron@classroom-admin-email";
const FINAL_RETRY_MINUTE = 7 * 60 + 30;

export interface AdminScheduleEmailResult {
  status: "sent" | "partial" | "failed" | "pending" | "skipped";
  assignmentDate: string;
  assignmentRunId: string | null;
  emailRunId: string | null;
  attempted: number;
  success: number;
  failed: number;
  message: string;
}

interface AdminEmailContext {
  assignmentDate: string;
  detail: ClassroomAssignmentDetail;
  publishJobs: ClassroomPublishJob[];
  teacherScheduleEmailSummary: TeacherScheduleEmailSummary | null;
  blockers: string[];
  triggerKind: "ready" | "failure";
}

interface TeacherScheduleEmailSummary {
  runCount: number;
  attempted: number;
  success: number;
  failed: number;
  blocked: number;
  latestStatus: string;
  latestUpdatedAt: Date;
}

function bangkokMinuteOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function formatMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function roomLabel(row: Pick<ClassroomRow, "status" | "assignedRoom">): string {
  if (row.status === "remote" || row.assignedRoom === REMOTE_NO_ROOM_NEEDED) {
    return "Remote / no room needed";
  }
  return row.assignedRoom;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function rowLabel(row: ClassroomRow): string {
  return row.studentName || row.title || row.subject || "Untitled class";
}

function classLabel(row: ClassroomRow): string {
  return row.subject || row.classType || row.title || "-";
}

function statusLine(row: ClassroomRow): string {
  const publish = row.publishStatus === "success"
    ? "Published"
    : row.publishStatus === "failed"
      ? `Publish failed: ${row.publishError ?? "unknown error"}`
      : row.publishStatus === "skipped"
        ? `Skipped: ${row.publishError ?? "not eligible"}`
        : "Not published";
  return `${row.status}; ${publish}; ${row.changeType}`;
}

function teacherEmailSummaryLine(summary: TeacherScheduleEmailSummary | null): string {
  if (!summary) return "Tutor schedule emails: not sent yet.";
  return [
    `Tutor schedule emails: ${summary.success} sent`,
    `${summary.failed} failed`,
    `${summary.blocked} blocked`,
    `${summary.attempted} attempted`,
    `${summary.runCount} run(s)`,
    `latest status ${summary.latestStatus}`,
  ].join("; ");
}

function renderText(context: AdminEmailContext): string {
  const rows = context.detail.rows;
  const lines = [
    `BeGifted classroom assignments - ${context.assignmentDate}`,
    "",
    `Run: ${context.detail.run?.id ?? "not available"}`,
    `Status: ${context.triggerKind === "ready" ? "ready" : "blocked/failure summary"}`,
    teacherEmailSummaryLine(context.teacherScheduleEmailSummary),
    "",
  ];

  if (context.blockers.length > 0) {
    lines.push("Blockers:", ...context.blockers.map((blocker) => `- ${blocker}`), "");
  }

  lines.push("Schedule:");
  if (rows.length === 0) {
    lines.push("- No current-day rows found.");
  } else {
    for (const row of rows) {
      lines.push(
        `- ${formatMinute(row.startMinute)}-${formatMinute(row.endMinute)} | ${row.tutorDisplayName} | ${rowLabel(row)} | ${classLabel(row)} | ${roomLabel(row)} | ${statusLine(row)}`,
      );
    }
  }

  const reviewRows = rows.filter((row) => row.status === "needs_review" || row.status === "no_room");
  if (reviewRows.length > 0) {
    lines.push("", "Needs review / no room:");
    for (const row of reviewRows) {
      lines.push(`- ${formatMinute(row.startMinute)} ${row.tutorDisplayName}: ${rowLabel(row)} (${row.status})`);
    }
  }

  return lines.join("\n");
}

function renderHtml(context: AdminEmailContext): string {
  const rows = context.detail.rows;
  const blockerHtml = context.blockers.length > 0
    ? `<h2>Blockers</h2><ul>${context.blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join("")}</ul>`
    : "";
  const teacherEmailSummary = context.teacherScheduleEmailSummary;
  const teacherEmailHtml = teacherEmailSummary
    ? `<p style="margin:0 0 18px;color:#475569;">Tutor schedule emails: <strong>${teacherEmailSummary.success}</strong> sent; <strong>${teacherEmailSummary.failed}</strong> failed; <strong>${teacherEmailSummary.blocked}</strong> blocked; ${teacherEmailSummary.attempted} attempted across ${teacherEmailSummary.runCount} run(s). Latest status: ${escapeHtml(teacherEmailSummary.latestStatus)}.</p>`
    : `<p style="margin:0 0 18px;color:#475569;">Tutor schedule emails: not sent yet.</p>`;
  const rowHtml = rows.length > 0
    ? rows.map((row) => `
      <tr>
        <td>${escapeHtml(`${formatMinute(row.startMinute)}-${formatMinute(row.endMinute)}`)}</td>
        <td>${escapeHtml(row.tutorDisplayName)}</td>
        <td>${escapeHtml(rowLabel(row))}</td>
        <td>${escapeHtml(classLabel(row))}</td>
        <td><strong>${escapeHtml(roomLabel(row))}</strong></td>
        <td>${escapeHtml(statusLine(row))}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="6">No current-day rows found.</td></tr>`;

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f8fafc;color:#0f172a;font-family:Arial,sans-serif;">
    <div style="max-width:960px;margin:0 auto;padding:24px;">
      <h1 style="margin:0 0 4px;font-size:24px;">BeGifted classroom assignments</h1>
      <p style="margin:0 0 18px;color:#475569;">${escapeHtml(context.assignmentDate)} - ${escapeHtml(context.triggerKind === "ready" ? "ready" : "blocked/failure summary")}</p>
      ${teacherEmailHtml}
      ${blockerHtml}
      <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #cbd5e1;">
        <thead>
          <tr style="background:#2563eb;color:#ffffff;text-align:left;">
            <th style="padding:9px;">Time</th>
            <th style="padding:9px;">Tutor</th>
            <th style="padding:9px;">Student/Class</th>
            <th style="padding:9px;">Subject</th>
            <th style="padding:9px;">Room</th>
            <th style="padding:9px;">Status</th>
          </tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </div>
  </body>
</html>`;
}

async function loadAdminEmails(db: Database): Promise<string[]> {
  const rows = await db
    .select({ email: schema.adminUsers.email })
    .from(schema.adminUsers);
  return [...new Set(rows.map((row) => row.email.trim().toLowerCase()).filter(Boolean))].sort();
}

async function loadPublishJobs(db: Database, runId: string): Promise<ClassroomPublishJob[]> {
  return db
    .select()
    .from(schema.classroomPublishJobs)
    .where(eq(schema.classroomPublishJobs.runId, runId))
    .orderBy(desc(schema.classroomPublishJobs.createdAt));
}

async function loadTeacherScheduleEmailSummary(
  db: Database,
  runId: string,
): Promise<TeacherScheduleEmailSummary | null> {
  const rows = await db
    .select({
      status: schema.classroomScheduleEmailRuns.status,
      attemptedCount: schema.classroomScheduleEmailRuns.attemptedCount,
      successCount: schema.classroomScheduleEmailRuns.successCount,
      failedCount: schema.classroomScheduleEmailRuns.failedCount,
      blockedCount: schema.classroomScheduleEmailRuns.blockedCount,
      updatedAt: schema.classroomScheduleEmailRuns.updatedAt,
    })
    .from(schema.classroomScheduleEmailRuns)
    .where(eq(schema.classroomScheduleEmailRuns.assignmentRunId, runId))
    .orderBy(desc(schema.classroomScheduleEmailRuns.updatedAt));

  if (rows.length === 0) return null;
  return rows.reduce<TeacherScheduleEmailSummary>((summary, row, index) => ({
    runCount: summary.runCount + 1,
    attempted: summary.attempted + row.attemptedCount,
    success: summary.success + row.successCount,
    failed: summary.failed + row.failedCount,
    blocked: summary.blocked + row.blockedCount,
    latestStatus: index === 0 ? row.status : summary.latestStatus,
    latestUpdatedAt: index === 0 ? row.updatedAt : summary.latestUpdatedAt,
  }), {
    runCount: 0,
    attempted: 0,
    success: 0,
    failed: 0,
    blocked: 0,
    latestStatus: rows[0].status,
    latestUpdatedAt: rows[0].updatedAt,
  });
}

async function hasTerminalAdminEmailForDate(db: Database, assignmentDate: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.classroomAdminEmailRuns.id })
    .from(schema.classroomAdminEmailRuns)
    .where(and(
      eq(schema.classroomAdminEmailRuns.assignmentDate, assignmentDate),
      inArray(schema.classroomAdminEmailRuns.status, ["sent", "partial", "failed"]),
    ))
    .limit(1);
  return rows.length > 0;
}

function publishPending(jobs: ClassroomPublishJob[]): boolean {
  return jobs.some((job) => job.status === "pending" || job.status === "running");
}

function buildBlockers(detail: ClassroomAssignmentDetail, publishJobs: ClassroomPublishJob[]): string[] {
  const blockers: string[] = [];
  if (!detail.run) {
    blockers.push("No classroom assignment run exists for the current Bangkok date.");
  }
  if (publishPending(publishJobs)) {
    blockers.push("Classroom publish job is still pending or running.");
  }
  const noRoomCount = detail.rows.filter((row) => row.status === "no_room").length;
  const needsReviewCount = detail.rows.filter((row) => row.status === "needs_review").length;
  const failedPublishCount = detail.rows.filter((row) => row.publishStatus === "failed").length;
  if (noRoomCount > 0) blockers.push(`${noRoomCount} row(s) have no room.`);
  if (needsReviewCount > 0) blockers.push(`${needsReviewCount} row(s) need review.`);
  if (failedPublishCount > 0) blockers.push(`${failedPublishCount} row(s) failed Wise publish.`);
  return blockers;
}

async function createEmailRun(
  db: Database,
  input: {
    assignmentDate: string;
    assignmentRunId: string | null;
    subject: string;
    triggerKind: "ready" | "failure";
  },
): Promise<typeof schema.classroomAdminEmailRuns.$inferSelect | null> {
  const idempotencyKey = `classroom-admin:${input.assignmentDate}`;
  try {
    const [run] = await db
      .insert(schema.classroomAdminEmailRuns)
      .values({
        assignmentDate: input.assignmentDate,
        assignmentRunId: input.assignmentRunId,
        subject: input.subject,
        idempotencyKey,
        triggerKind: input.triggerKind,
        createdBy: ADMIN_EMAIL_ACTOR,
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

async function finalizeEmailRun(
  db: Database,
  emailRunId: string,
  counts: { attempted: number; success: number; failed: number },
): Promise<void> {
  const status = counts.failed > 0
    ? counts.success > 0
      ? "partial"
      : "failed"
    : "sent";
  await db
    .update(schema.classroomAdminEmailRuns)
    .set({
      status,
      attemptedCount: counts.attempted,
      successCount: counts.success,
      failedCount: counts.failed,
      sentAt: counts.success > 0 ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.classroomAdminEmailRuns.id, emailRunId));
}

export async function sendAdminClassroomScheduleEmail(
  db: Database = getDb(),
  options: {
    now?: Date;
    assignmentDate?: string;
    sender?: ScheduleEmailSender;
  } = {},
): Promise<AdminScheduleEmailResult> {
  const now = options.now ?? new Date();
  const assignmentDate = options.assignmentDate ?? todayBangkok(now);
  if (await hasTerminalAdminEmailForDate(db, assignmentDate)) {
    return {
      status: "skipped",
      assignmentDate,
      assignmentRunId: null,
      emailRunId: null,
      attempted: 0,
      success: 0,
      failed: 0,
      message: "Admin classroom schedule email already recorded for this date.",
    };
  }

  const detail = await getClassroomAssignmentForDate(db, assignmentDate);
  const publishJobs = detail.run ? await loadPublishJobs(db, detail.run.id) : [];
  const teacherScheduleEmailSummary = detail.run
    ? await loadTeacherScheduleEmailSummary(db, detail.run.id)
    : null;
  const blockers = buildBlockers(detail, publishJobs);
  const finalRetry = bangkokMinuteOfDay(now) >= FINAL_RETRY_MINUTE;
  const stillPreparing = !detail.run || publishPending(publishJobs);
  if (stillPreparing && !finalRetry) {
    return {
      status: "pending",
      assignmentDate,
      assignmentRunId: detail.run?.id ?? null,
      emailRunId: null,
      attempted: 0,
      success: 0,
      failed: 0,
      message: "Classroom automation is not ready yet; retry window remains open.",
    };
  }

  const triggerKind = stillPreparing ? "failure" : "ready";
  const subject = triggerKind === "ready"
    ? `BeGifted classroom assignments - ${assignmentDate}`
    : `ACTION REQUIRED: classroom assignments not ready - ${assignmentDate}`;
  const emailRun = await createEmailRun(db, {
    assignmentDate,
    assignmentRunId: detail.run?.id ?? null,
    subject,
    triggerKind,
  });
  if (!emailRun) {
    return {
      status: "skipped",
      assignmentDate,
      assignmentRunId: detail.run?.id ?? null,
      emailRunId: null,
      attempted: 0,
      success: 0,
      failed: 0,
      message: "Admin classroom schedule email was already created concurrently.",
    };
  }

  const recipients = await loadAdminEmails(db);
  const context: AdminEmailContext = {
    assignmentDate,
    detail,
    publishJobs,
    teacherScheduleEmailSummary,
    blockers,
    triggerKind,
  };
  const sender = options.sender ?? createAppsScriptScheduleEmailSender();
  const html = renderHtml(context);
  const text = renderText(context);
  const counts = { attempted: 0, success: 0, failed: 0 };

  if (recipients.length === 0) {
    counts.failed = 1;
    await db
      .update(schema.classroomAdminEmailRuns)
      .set({
        status: "failed",
        failedCount: 1,
        lastError: "No admin_users email recipients are configured.",
        updatedAt: new Date(),
      })
      .where(eq(schema.classroomAdminEmailRuns.id, emailRun.id));
    return {
      status: "failed",
      assignmentDate,
      assignmentRunId: detail.run?.id ?? null,
      emailRunId: emailRun.id,
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
        idempotencyKey: `classroom-admin:${assignmentDate}:${email}`,
      });
      counts.success += 1;
      await db.insert(schema.classroomAdminEmailRecipients).values({
        emailRunId: emailRun.id,
        assignmentDate,
        recipientEmail: email,
        status: "sent",
        providerMessageId: sent.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Admin classroom email failed";
      counts.failed += 1;
      await db.insert(schema.classroomAdminEmailRecipients).values({
        emailRunId: emailRun.id,
        assignmentDate,
        recipientEmail: email,
        status: "failed",
        error: message,
      });
    }
  }

  await finalizeEmailRun(db, emailRun.id, counts);
  const status = counts.failed > 0 ? (counts.success > 0 ? "partial" : "failed") : "sent";
  return {
    status,
    assignmentDate,
    assignmentRunId: detail.run?.id ?? null,
    emailRunId: emailRun.id,
    attempted: counts.attempted,
    success: counts.success,
    failed: counts.failed,
    message: `Admin classroom schedule email ${status}.`,
  };
}
