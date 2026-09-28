import { and, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { CronJobHealth } from "@/lib/data-health/types";
import { latestNightlyDate, nightlyCheckpoint, nightlyCounts, nightlyWindow } from "./nightly-reminder-model";

export async function loadNightlyReminderHealth(db: Database = getDb(), now = new Date()) {
  const [config] = await db.select().from(schema.postClassSettings).limit(1);
  const mode = config?.reminderMode ?? "off";
  const [uncertain] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.postClassNotificationDeliveries)
    .innerJoin(schema.postClassNotificationRuns, eq(schema.postClassNotificationDeliveries.runId, schema.postClassNotificationRuns.id))
    .where(and(eq(schema.postClassNotificationRuns.kind, "tutor_nightly"), or(
      eq(schema.postClassNotificationDeliveries.status, "unknown"),
      and(eq(schema.postClassNotificationDeliveries.status, "sending"), lt(schema.postClassNotificationDeliveries.updatedAt, new Date(now.getTime() - 15 * 60_000))),
    )));
  const unresolvedDeliveries = Number(uncertain?.count ?? 0);
  const [alert] = await db.select().from(schema.cronAlertState).where(eq(schema.cronAlertState.jobKey, "post_class_feedback_nightly")).limit(1);
  const alertDeliveryError = alert?.errorSummary?.startsWith("Alert delivery failure:") ? alert.errorSummary : null;
  let date = latestNightlyDate(now, mode === "live" ? config?.reminderActivatedAt ?? null : config?.reminderStartedAt ?? null);
  if (!date && mode === "shadow") {
    const [preview] = await db.select().from(schema.postClassNotificationRuns).where(and(
      eq(schema.postClassNotificationRuns.kind, "tutor_nightly"), sql`${schema.postClassNotificationRuns.metadata}->>'mode' = 'shadow'`,
      gte(schema.postClassNotificationRuns.startedAt, config?.reminderStartedAt ?? now),
    )).orderBy(desc(schema.postClassNotificationRuns.scheduledFor)).limit(1);
    date = typeof preview?.metadata.date === "string" ? preview.metadata.date : null;
  }
  const base = { mode, date, activatedAt: config?.reminderActivatedAt?.toISOString() ?? null,
    startedAt: config?.reminderStartedAt?.toISOString() ?? null,
    legacyDisabledAt: config?.legacyReminderDisabledAt?.toISOString() ?? null, unresolvedDeliveries, alertDeliveryError };
  if (mode === "off" || !date) return { ...base, status: unresolvedDeliveries ? "failing" as const : "healthy" as const,
    runId: null, counts: nightlyCounts([]), acceptedEmails: 0, coverageGaps: 0, sourceCheckedAt: null, sourceComplete: false,
    detail: unresolvedDeliveries ? `${unresolvedDeliveries} uncertain deliveries still require reconciliation.`
      : mode === "off" ? "Nightly reminders are off. Saved work is retained." : "Waiting for the first prospective 22:00 Bangkok batch." };
  const [run] = await db.select().from(schema.postClassNotificationRuns)
    .where(eq(schema.postClassNotificationRuns.idempotencyKey, `post-class-feedback:nightly:${mode}:${date}`)).limit(1);
  const rows = run ? await db.select({ status: schema.postClassReminderLedger.status }).from(schema.postClassReminderLedger)
    .where(eq(schema.postClassReminderLedger.runId, run.id)) : [];
  const counts = nightlyCounts(rows);
  const window = nightlyWindow(date);
  // Recompute from canonical sessions, independently of the worker's counters.
  const [gaps] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.postClassSessions)
    .leftJoin(schema.postClassReminderLedger, and(
      eq(schema.postClassReminderLedger.wiseSessionId, schema.postClassSessions.wiseSessionId),
      eq(schema.postClassReminderLedger.reminderDate, date), eq(schema.postClassReminderLedger.mode, mode),
    )).where(and(eq(schema.postClassSessions.eligible, true), eq(schema.postClassSessions.enforcementMode, "live"),
      gte(schema.postClassSessions.scheduledEndAt, window.start), lte(schema.postClassSessions.scheduledEndAt, window.cutoff),
      isNull(schema.postClassReminderLedger.id)));
  const coverageGaps = Number(gaps?.count ?? 0);
  const [accepted] = run ? await db.select({ count: sql<number>`count(*)::int` }).from(schema.postClassNotificationDeliveries)
    .where(and(eq(schema.postClassNotificationDeliveries.runId, run.id), eq(schema.postClassNotificationDeliveries.status, "sent"))) : [];
  const afterGrace = now.getTime() >= nightlyCheckpoint(date).getTime() + 30 * 60_000;
  const sourceComplete = run?.metadata.sourceComplete === true;
  const outstanding = counts.blockedSource + counts.blockedRecipient + counts.unknown + counts.failed + counts.pending +
    (mode === "live" ? counts.ready : 0);
  const hardFailure = Boolean(run?.errorSummary) || unresolvedDeliveries > 0 || counts.failed > 0;
  const failed = hardFailure || (afterGrace && (!sourceComplete || outstanding > 0 || coverageGaps > 0 || (mode === "live" && counts.expired > 0)));
  return { ...base, status: failed ? "failing" as const : "healthy" as const, runId: run?.id ?? null, counts, coverageGaps,
    acceptedEmails: Number(accepted?.count ?? 0),
    sourceComplete, sourceCheckedAt: typeof run?.metadata.sourceCheckedAt === "string" ? run.metadata.sourceCheckedAt : null,
    detail: run?.errorSummary ?? (failed
      ? `${outstanding} unresolved classes, ${unresolvedDeliveries} uncertain deliveries across all nights, ${counts.expired} missed deadlines, ${coverageGaps} coverage gaps; source ${sourceComplete ? "verified" : "unverified"}.`
      : `${counts.sent} classes notified; ${counts.excluded} excluded; ${counts.ready} ready${mode === "shadow" ? " in shadow mode" : ""}.`),
  };
}

export type NightlyReminderHealth = Awaited<ReturnType<typeof loadNightlyReminderHealth>>;

/** Used by the dashboard and watchdog; query failure is visible, never omitted. */
export async function applyNightlyReminderHealth(jobs: CronJobHealth[], db: Database, now: Date) {
  const job = jobs.find((row) => row.key === "post_class_feedback_nightly");
  if (!job) return jobs;
  try {
    const health = await loadNightlyReminderHealth(db, now);
    const status = health.status === "failing" ? "failing" : health.mode === "off" ? "paused" : job.status;
    return jobs.map((row) => row === job ? { ...row, status, healthDetail: [health.detail, health.alertDeliveryError].filter(Boolean).join(" "),
      errorSummary: health.status === "failing" ? health.detail : row.errorSummary } : row);
  } catch {
    return jobs.map((row) => row === job ? { ...row, status: "unknown" as const,
      errorSummary: "Nightly reminder coverage could not be evaluated.", healthDetail: "Nightly reminder coverage could not be evaluated." } : row);
  }
}

export async function nightlyReminderHistory(db: Database, input: { sessionId?: string; tutorKey?: string; limit?: number; canManageAccess?: boolean }) {
  return db.select({ id: schema.postClassReminderLedger.id, date: schema.postClassReminderLedger.reminderDate,
    mode: schema.postClassReminderLedger.mode, status: schema.postClassReminderLedger.status, reason: schema.postClassReminderLedger.reason,
    wiseSessionId: schema.postClassReminderLedger.wiseSessionId, className: schema.postClassSessions.className,
    scheduledEndAt: schema.postClassReminderLedger.scheduledEndAt, recipient: input.canManageAccess ? schema.postClassNotificationDeliveries.recipientEmail : sql<string | null>`null`,
    sessionId: schema.postClassReminderLedger.sessionId, tutorKey: schema.postClassReminderLedger.canonicalTutorKey,
    deliveryId: schema.postClassReminderLedger.deliveryId, sentAt: schema.postClassNotificationDeliveries.sentAt,
    receipt: schema.postClassNotificationDeliveries.providerMessageId, attemptCount: schema.postClassNotificationDeliveries.attemptCount,
    sourceObservedAt: schema.postClassReminderLedger.sourceObservedAt,
  }).from(schema.postClassReminderLedger).leftJoin(schema.postClassSessions, eq(schema.postClassReminderLedger.sessionId, schema.postClassSessions.id))
    .leftJoin(schema.postClassNotificationDeliveries,
    eq(schema.postClassReminderLedger.deliveryId, schema.postClassNotificationDeliveries.id))
    .where(and(input.sessionId ? eq(schema.postClassReminderLedger.sessionId, input.sessionId) : undefined,
      input.tutorKey ? eq(schema.postClassReminderLedger.canonicalTutorKey, input.tutorKey) : undefined))
    .orderBy(sql`case when ${schema.postClassReminderLedger.status} = 'unknown' then 0 else 1 end`, desc(schema.postClassReminderLedger.reminderDate), desc(schema.postClassReminderLedger.updatedAt))
    .limit(Math.min(500, input.limit ?? 100));
}
