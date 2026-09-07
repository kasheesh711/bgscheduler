import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { classroomWeekendChecks as checks, classroomWeekendNotifications as notifications } from "@/lib/db/schema";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { isWeekendCheckDue, weekendAlertRecipient, weekendDates, WEEKEND_CHECK_LEASE_MS } from "./weekend-config";
import { previewWeekendReadiness } from "./weekend-preview";
import { notificationForReport, type WeekendReport } from "./weekend-readiness";
import { buildWeekendEmail } from "./weekend-email";
import { createAppsScriptScheduleEmailSender, type ScheduleEmailSender } from "./schedule-email";

export async function claimWeekendCheck(db: Database, now: Date) {
  const [check] = await db.insert(checks).values({ checkDate: todayBangkok(now), weekendDate: weekendDates(now)[0], claimedAt: now })
    .onConflictDoUpdate({ target: checks.checkDate, set: { status: "running", claimedAt: now, lastError: null },
      setWhere: or(eq(checks.status, "failed"), eq(checks.status, "retry_pending"),
        and(eq(checks.status, "running"), lt(checks.claimedAt, new Date(now.getTime() - WEEKEND_CHECK_LEASE_MS)))) }).returning();
  return check ?? null;
}

export function weekendClaimPredicate(id: string, claimedAt: Date) {
  return and(eq(checks.id, id), eq(checks.status, "running"), eq(checks.claimedAt, claimedAt));
}

export async function assertWeekendClaim(db: Database, id: string, claimedAt: Date, now: Date) {
  if (now.getTime() - claimedAt.getTime() >= WEEKEND_CHECK_LEASE_MS - 30_000) throw new Error("Weekend verification lease expired");
  const [claim] = await db.select({ id: checks.id }).from(checks).where(weekendClaimPredicate(id, claimedAt)).limit(1);
  if (!claim) throw new Error("Weekend verification no longer owns its claim");
}

export async function loadWeekendCheck(db: Database, options: { checkId?: string; now?: Date } = {}) {
  const [check] = await db.select().from(checks).where(options.checkId ? eq(checks.id, options.checkId)
    : eq(checks.weekendDate, weekendDates(options.now ?? new Date())[0])).orderBy(desc(checks.checkDate)).limit(1);
  if (!check) return null;
  // Delivery addresses and rendered mail are deliberately absent from the UI response.
  const [delivery] = await db.select({ status: notifications.status, sentAt: notifications.sentAt, kind: notifications.kind })
    .from(notifications).where(eq(notifications.checkId, check.id)).limit(1);
  return { id: check.id, checkDate: check.checkDate, status: check.status, report: check.report,
    lastError: check.lastError, delivery: delivery ?? null };
}

export async function runWeekendClassroomCheck(db: Database = getDb(), options: {
  now?: Date;
  evaluate?: (db: Database, dates: [string, string]) => Promise<WeekendReport>;
  sender?: ScheduleEmailSender;
} = {}) {
  const now = options.now ?? new Date();
  const started = Date.now();
  const clock = () => new Date(now.getTime() + Date.now() - started);
  if (!isWeekendCheckDue(now)) return { ok: true, skipped: true, message: "Outside the enabled Wednesday–Friday check schedule." };
  const recipient = weekendAlertRecipient();
  const check = await claimWeekendCheck(db, now);
  if (!check) return { ok: true, skipped: true, message: "Weekend check is complete or another attempt owns the claim." };
  const claim = weekendClaimPredicate(check.id, now);
  try {
    let report = check.report;
    let [notification] = await db.select().from(notifications).where(eq(notifications.checkId, check.id));
    // Deliver an already-created notification before re-evaluating it. Once an unverified
    // notice is accepted, later retry ticks can improve the report without sending it twice.
    if (!report || (report.readiness === "unverified" && notification?.status === "sent")) {
      try { report = await (options.evaluate ?? previewWeekendReadiness)(db, weekendDates(now)); }
      catch (error) {
        report = { checkedAt: clock().toISOString(), dates: weekendDates(now), snapshotId: null, snapshotFinishedAt: null,
          readiness: "unverified", days: [], findings: [{ date: weekendDates(now)[0], kind: "unverified",
            message: error instanceof Error ? error.message : "Weekend classroom verification failed" }] };
      }
      await assertWeekendClaim(db, check.id, now, clock());
      await db.update(checks).set({ report }).where(claim);
    }
    if (!notification) {
      const [previous] = await db.select({ kind: notifications.kind }).from(notifications)
        .where(and(eq(notifications.weekendDate, check.weekendDate), eq(notifications.recipient, recipient), eq(notifications.status, "sent")))
        .orderBy(desc(notifications.sentAt)).limit(1);
      const kind = notificationForReport(report.readiness, previous?.kind ?? null);
      if (kind) {
        await assertWeekendClaim(db, check.id, now, clock());
        [notification] = await db.insert(notifications).values({ checkId: check.id, weekendDate: check.weekendDate, kind, recipient,
          idempotencyKey: `classroom-weekend:${check.checkDate}:${check.weekendDate}:${recipient}`,
          ...buildWeekendEmail(report, check.id, kind) }).returning();
      }
    }
    if (notification && notification.status !== "sent") {
      // Never deliver a saved outbox item to a former recipient after configuration changes.
      if (notification.recipient !== recipient) throw new Error("Weekend alert recipient changed; review the pending notification before retrying");
      await assertWeekendClaim(db, check.id, now, clock());
      await db.update(notifications).set({ attempts: sql`${notifications.attempts} + 1`, lastError: null }).where(eq(notifications.id, notification.id));
      try {
        const sent = await (options.sender ?? createAppsScriptScheduleEmailSender()).sendEmail({
          to: recipient, subject: notification.subject, text: notification.text, html: notification.html, idempotencyKey: notification.idempotencyKey });
        await assertWeekendClaim(db, check.id, now, clock());
        await db.update(notifications).set({ status: "sent", sentAt: clock(), providerMessageId: sent.id, lastError: null })
          .where(eq(notifications.id, notification.id));
      } catch (error) {
        await assertWeekendClaim(db, check.id, now, clock());
        await db.update(notifications).set({ status: "failed", lastError: error instanceof Error ? error.message : "Email delivery failed" })
          .where(eq(notifications.id, notification.id));
        throw error;
      }
    }
    await assertWeekendClaim(db, check.id, now, clock());
    await db.update(checks).set({ status: report.readiness === "unverified" ? "retry_pending" : "completed", finishedAt: clock(), lastError: null }).where(claim);
    return { ok: true, checkId: check.id, readiness: report.readiness, findingCount: report.findings.length,
      notification: notification?.kind ?? "quiet", message: "Weekend assessment completed; readiness is reported separately." };
  } catch (error) {
    const errorSummary = error instanceof Error ? error.message : "Weekend classroom check failed";
    await db.update(checks).set({ status: "failed", lastError: errorSummary, finishedAt: clock() }).where(claim);
    return { ok: false, checkId: check.id, errorSummary };
  }
}
