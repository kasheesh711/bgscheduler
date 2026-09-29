import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { createAppsScriptScheduleEmailSender, type ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { pushLineTextMessage } from "@/lib/line/client";

/**
 * Incident outbox of the operating loop. A critical incident (a critical verdict, an API write no post explains)
 * is pushed to the owner at any hour: email to `FEEDBACK_AUTOWRITER_ALERT_EMAILS` through the Apps Script relay,
 * and LINE to `FEEDBACK_AUTOWRITER_LINE_TO` when set. Each channel is sent once (idempotency and retry keys) and a
 * failed push is retried on the next run, up to MAX_PUSH_ATTEMPTS. Info incidents are only shown on the dashboard.
 */

const I = schema.feedbackAutowriterIncidents;

export type IncidentRow = typeof I.$inferSelect;
export type IncidentKind = IncidentRow["kind"];

export const MAX_PUSH_ATTEMPTS = 5;
/** Retry spacing after a failed push (the job itself runs hourly). */
const RETRY_AFTER_MS = 30 * 60 * 1000;
const DASHBOARD_URL = "https://bgscheduler.vercel.app/feedback-autowriter";

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
  pushLine?: (input: { to: string; text: string; retryKey: string }) => Promise<unknown>;
}

export interface DrainResult {
  attempted: number;
  sent: number;
  failed: number;
  stillPending: number;
  errors: string[];
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
 * Push every pending critical incident that is due. A channel that succeeded is recorded and never re-sent; the
 * incident is `sent` once every configured channel has it, `failed` after MAX_PUSH_ATTEMPTS. With no channel
 * configured nothing is attempted (the incident stays pending and the run reports it).
 */
export async function drainIncidentOutbox(db: Database, channels: IncidentPushChannels, now = new Date()): Promise<DrainResult> {
  const result: DrainResult = { attempted: 0, sent: 0, failed: 0, stillPending: 0, errors: [] };
  const due = await db.select().from(I).where(and(
    eq(I.pushStatus, "pending"),
    or(isNull(I.nextPushAt), lte(I.nextPushAt, now)),
  )).orderBy(asc(I.createdAt)).limit(50);
  const wanted = [
    ...(channels.emailRecipients.length > 0 ? ["email"] : []),
    ...(channels.lineTo ? ["line"] : []),
  ];
  if (due.length > 0 && wanted.length === 0) {
    result.stillPending = due.length;
    result.errors.push("No push channel configured (FEEDBACK_AUTOWRITER_ALERT_EMAILS / FEEDBACK_AUTOWRITER_LINE_TO)");
    return result;
  }
  let emailSender = channels.emailSender;
  for (const incident of due) {
    result.attempted += 1;
    const done = new Set(incident.pushedChannels);
    const errors: string[] = [];
    const text = incidentText(incident);
    if (wanted.includes("email") && !done.has("email")) {
      try {
        emailSender ??= createAppsScriptScheduleEmailSender("primary", { strictOutcome: true });
        for (const to of channels.emailRecipients) {
          await emailSender.sendEmail({
            to,
            subject: `Feedback autowriter: ${incident.severity} — ${incident.summary.slice(0, 120)}`,
            text,
            html: `<p>${escapeHtml(text).replace(/\n/gu, "<br>")}</p>`,
            idempotencyKey: `feedback-autowriter-incident:${incident.id}:${to}`,
          });
        }
        done.add("email");
      } catch (error) {
        errors.push(`email: ${error instanceof Error ? error.message.slice(0, 160) : "relay failed"}`);
      }
    }
    if (wanted.includes("line") && channels.lineTo && !done.has("line")) {
      try {
        await (channels.pushLine ?? pushLineTextMessage)({ to: channels.lineTo, text, retryKey: incident.id });
        done.add("line");
      } catch (error) {
        errors.push(`line: ${error instanceof Error ? error.message.slice(0, 160) : "push failed"}`);
      }
    }
    const complete = wanted.every((channel) => done.has(channel));
    const attempts = incident.pushAttempts + 1;
    const status = complete ? "sent" : attempts >= MAX_PUSH_ATTEMPTS ? "failed" : "pending";
    await db.update(I).set({
      pushStatus: status,
      pushAttempts: attempts,
      pushedChannels: [...done],
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
