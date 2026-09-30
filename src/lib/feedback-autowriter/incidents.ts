import { and, asc, count, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { createAppsScriptScheduleEmailSender, type ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { pushLineTextMessage } from "@/lib/line/client";

/**
 * Incident outbox of the operating loop. A critical incident (a critical verdict, an API write no post explains, a
 * first shot that landed without verifying) is pushed to the owner at any hour: email to each address in
 * `FEEDBACK_AUTOWRITER_ALERT_EMAILS` through the Apps Script relay, and LINE to `FEEDBACK_AUTOWRITER_LINE_TO` when
 * set. Delivery is tracked per target (`email:<address>`, `line:<to>` in `pushed_channels`), so a retry never
 * re-sends to a target that already has it; a failed push is retried on the next run, up to MAX_PUSH_ATTEMPTS.
 * An undelivered critical incident keeps the review job red until the owner acknowledges it. Info incidents are
 * only shown on the dashboard.
 */

const I = schema.feedbackAutowriterIncidents;

export type IncidentRow = typeof I.$inferSelect;
export type IncidentKind = IncidentRow["kind"];

export const MAX_PUSH_ATTEMPTS = 5;
/** Retry spacing after a failed push (the job itself runs hourly). */
const RETRY_AFTER_MS = 30 * 60 * 1000;
const DASHBOARD_URL = "https://bgscheduler.vercel.app/feedback-autowriter";
/** Worst case of one relay send (the sender's own abort) plus slack; the drain never starts a push it cannot finish. */
const EMAIL_SEND_BUDGET_MS = 21_000;
export const LINE_PUSH_TIMEOUT_MS = 10_000;
const LINE_PUSH_BUDGET_MS = LINE_PUSH_TIMEOUT_MS + 1_000;
const INCIDENT_WRITE_BUDGET_MS = 5_000;

export interface IncidentInput {
  dedupeKey: string;
  kind: IncidentKind;
  severity: "critical" | "info";
  wiseSessionId?: string | null;
  summary: string;
  detail?: Record<string, unknown>;
}

/** Insert once per dedupe key; returns true when this call created it. */
export async function recordIncident(db: Database, input: IncidentInput): Promise<boolean> {
  const rows = await db.insert(I).values({
    dedupeKey: input.dedupeKey,
    kind: input.kind,
    severity: input.severity,
    wiseSessionId: input.wiseSessionId ?? null,
    summary: input.summary.slice(0, 500),
    detail: input.detail ?? {},
    pushStatus: input.severity === "critical" ? "pending" : "not_required",
  }).onConflictDoNothing({ target: I.dedupeKey }).returning({ id: I.id });
  return rows.length > 0;
}

export interface IncidentPushChannels {
  emailRecipients: readonly string[];
  lineTo: string | null;
  emailSender?: ScheduleEmailSender;
  pushLine?: (input: { to: string; text: string; retryKey: string; signal?: AbortSignal }) => Promise<unknown>;
  lineTimeoutMs?: number;
}

export interface DrainResult {
  attempted: number;
  sent: number;
  failed: number;
  stillPending: number;
  /** Due incidents left for the next run because the function's time budget could not fit their push. */
  deferred: number;
  errors: string[];
}

/** The delivery targets of the configured channels, as recorded in `pushed_channels`. */
export function pushTargets(channels: Pick<IncidentPushChannels, "emailRecipients" | "lineTo">): string[] {
  return [
    ...[...new Set(channels.emailRecipients.map((address) => address.trim().toLowerCase()).filter(Boolean))].map((address) => `email:${address}`),
    ...(channels.lineTo ? [`line:${channels.lineTo}`] : []),
  ];
}

function incidentText(incident: Pick<IncidentRow, "severity" | "kind" | "summary" | "wiseSessionId">): string {
  return [
    `Feedback autowriter — ${incident.severity.toUpperCase()}: ${incident.summary}`,
    incident.wiseSessionId ? `Class: ${incident.wiseSessionId}` : null,
    `Review: ${DASHBOARD_URL}`,
  ].filter(Boolean).join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

/**
 * Push every pending critical incident that is due and not acknowledged. Each target that accepts is recorded at
 * once and never re-sent; the incident is `sent` once every configured target has it, `failed` after
 * MAX_PUSH_ATTEMPTS. With no channel configured nothing is attempted (the incident stays pending and the run
 * reports it). An incident whose worst-case push time does not fit before `deadlineMs` is left for the next run.
 */
export async function drainIncidentOutbox(
  db: Database,
  channels: IncidentPushChannels,
  now = new Date(),
  options: { deadlineMs?: number; wallClock?: () => number } = {},
): Promise<DrainResult> {
  const result: DrainResult = { attempted: 0, sent: 0, failed: 0, stillPending: 0, deferred: 0, errors: [] };
  const wallClock = options.wallClock ?? Date.now;
  const due = await db.select().from(I).where(and(
    eq(I.pushStatus, "pending"),
    isNull(I.acknowledgedAt),
    or(isNull(I.nextPushAt), lte(I.nextPushAt, now)),
  )).orderBy(asc(I.createdAt)).limit(50);
  const targets = pushTargets(channels);
  if (due.length > 0 && targets.length === 0) {
    result.stillPending = due.length;
    result.errors.push("No push channel configured (FEEDBACK_AUTOWRITER_ALERT_EMAILS / FEEDBACK_AUTOWRITER_LINE_TO)");
    return result;
  }
  let emailSender = channels.emailSender;
  const pushLine = channels.pushLine ?? pushLineTextMessage;
  for (const [index, incident] of due.entries()) {
    const done = new Set(incident.pushedChannels);
    const pending = targets.filter((target) => !done.has(target));
    const needMs = pending.filter((target) => target.startsWith("email:")).length * EMAIL_SEND_BUDGET_MS
      + (pending.some((target) => target.startsWith("line:")) ? LINE_PUSH_BUDGET_MS : 0) + INCIDENT_WRITE_BUDGET_MS;
    if (options.deadlineMs !== undefined && wallClock() + needMs > options.deadlineMs) {
      result.deferred = due.length - index;
      result.errors.push(`${result.deferred} critical incident push(es) deferred to the next run (time budget)`);
      break;
    }
    result.attempted += 1;
    const errors: string[] = [];
    const text = incidentText(incident);
    for (const target of pending) {
      try {
        if (target.startsWith("email:")) {
          const to = target.slice("email:".length);
          emailSender ??= createAppsScriptScheduleEmailSender("primary", { strictOutcome: true });
          await emailSender.sendEmail({
            to,
            subject: `Feedback autowriter: ${incident.severity} — ${incident.summary.slice(0, 120)}`,
            text,
            html: `<p>${escapeHtml(text).replace(/\n/gu, "<br>")}</p>`,
            idempotencyKey: `feedback-autowriter-incident:${incident.id}:${to}`,
          });
        } else {
          // One LINE target; the incident id is the (UUID) retry key LINE de-duplicates on.
          await pushLine({
            to: target.slice("line:".length),
            text,
            retryKey: incident.id,
            signal: AbortSignal.timeout(channels.lineTimeoutMs ?? LINE_PUSH_TIMEOUT_MS),
          });
        }
        done.add(target);
        // Recorded per target at once: a run killed mid-incident never re-sends what was accepted.
        await db.update(I).set({ pushedChannels: sql`array_append(${I.pushedChannels}, ${target})` })
          .where(and(eq(I.id, incident.id), sql`not (${target} = any(${I.pushedChannels}))`));
      } catch (error) {
        const channel = target.startsWith("email:") ? "email" : "line";
        errors.push(`${channel}: ${error instanceof Error ? error.message.slice(0, 160) : "push failed"}`);
      }
    }
    const complete = targets.every((target) => done.has(target));
    const attempts = incident.pushAttempts + 1;
    const status = complete ? "sent" : attempts >= MAX_PUSH_ATTEMPTS ? "failed" : "pending";
    await db.update(I).set({
      pushStatus: status,
      pushAttempts: attempts,
      pushedAt: complete ? sql`now()` : incident.pushedAt,
      lastPushError: errors.length > 0 ? errors.join("; ").slice(0, 500) : null,
      nextPushAt: status === "pending" ? new Date(now.getTime() + RETRY_AFTER_MS) : null,
    }).where(and(eq(I.id, incident.id), eq(I.pushStatus, "pending")));
    if (status === "sent") result.sent += 1;
    else if (status === "failed") result.failed += 1;
    else result.stillPending += 1;
    if (errors.length > 0) result.errors.push(`${incident.kind} ${incident.wiseSessionId ?? ""}: ${errors.join("; ")}`.trim());
  }
  return result;
}

/**
 * Critical incidents that did not reach the owner and were not acknowledged: gave up (`failed`), tried and still
 * pending, or due and never tried (beyond a run's batch, or deferred) — counted after the run's drain, so every one
 * that should have gone out by now keeps the run red.
 */
export async function countUndeliveredCritical(db: Database, now = new Date()): Promise<number> {
  const [row] = await db.select({ total: count() }).from(I).where(and(
    eq(I.severity, "critical"),
    isNull(I.acknowledgedAt),
    or(
      eq(I.pushStatus, "failed"),
      and(eq(I.pushStatus, "pending"), or(gt(I.pushAttempts, 0), isNull(I.nextPushAt), lte(I.nextPushAt, now))),
    ),
  ));
  return row?.total ?? 0;
}

/** The owner has seen the incident: no more pushes, and it no longer keeps the review job red. Idempotent; null when unknown. */
export async function acknowledgeIncident(db: Database, input: { incidentId: string; actor: string }): Promise<{
  id: string;
  acknowledgedAt: string;
  acknowledgedBy: string;
} | null> {
  await db.update(I).set({ acknowledgedAt: sql`now()`, acknowledgedBy: input.actor })
    .where(and(eq(I.id, input.incidentId), isNull(I.acknowledgedAt)));
  const [row] = await db.select({ id: I.id, acknowledgedAt: I.acknowledgedAt, acknowledgedBy: I.acknowledgedBy })
    .from(I).where(eq(I.id, input.incidentId)).limit(1);
  if (!row?.acknowledgedAt) return null;
  return { id: row.id, acknowledgedAt: row.acknowledgedAt.toISOString(), acknowledgedBy: row.acknowledgedBy ?? input.actor };
}
