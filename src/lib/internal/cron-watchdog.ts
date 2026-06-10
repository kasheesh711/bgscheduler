// Cron watchdog — sweeps every registered cron job using the same health
// derivation as /data-health and emails admins when jobs become unhealthy.
//
// Episode-based dedup: one alert email per job per failure episode, persisted
// in cron_alert_state. A job's episode opens when it first turns unhealthy
// (lastAlertOutcome = "alerted") and closes when a recovery notice goes out
// (lastAlertOutcome = "recovered"), which re-arms the next alert. Alert state
// is only written after at least one recipient accepted the email, so a
// failed delivery is retried on the next sweep instead of silently dropped.

import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  createAppsScriptScheduleEmailSender,
  type ScheduleEmailSender,
} from "@/lib/classrooms/schedule-email";
import { getCronJobsHealth } from "@/lib/data-health/dashboard";
import type { CronJobHealth, CronJobStatus } from "@/lib/data-health/types";
import { APP_BASE_URL } from "@/lib/leave-requests/config";

export type CronAlertStateRow = typeof schema.cronAlertState.$inferSelect;

/** The watchdog's own registry key; it never alerts about itself flapping. */
export const WATCHDOG_JOB_KEY = "cron_watchdog";

/**
 * Sentinel cron_alert_state row used as a single-flight sweep lock (the
 * watchdog has no *_sync_runs table to carry a `running`-row guard, and
 * neon-http supports neither transactions nor session advisory locks).
 * Never matches a registry job key, so it is invisible to classification.
 */
export const SWEEP_LOCK_KEY = "__watchdog_sweep_lock";

/** A crashed sweep's lock is reclaimable after route maxDuration (300s) + buffer. */
const SWEEP_LOCK_STALE_MS = 6 * 60 * 1000;

const ALERTABLE_STATUSES: ReadonlySet<CronJobStatus> = new Set(["failing", "late", "unknown"]);

export interface CronWatchdogSweep {
  checked: CronJobHealth[];
  unhealthy: CronJobHealth[];
  newAlerts: CronJobHealth[];
  recoveries: CronJobHealth[];
}

export interface CronWatchdogSummary {
  checked: number;
  unhealthy: number;
  alertsSent: number;
  recoveries: number;
  emailRecipients: number;
  skippedReason: string | null;
}

export interface RunCronWatchdogOptions {
  now?: Date;
  sender?: ScheduleEmailSender;
  loadJobs?: (now: Date) => Promise<CronJobHealth[]>;
}

/** `failing` covers failed and stuck-running jobs; `unknown` covers never-ran. */
export function isAlertableStatus(status: CronJobStatus): boolean {
  return ALERTABLE_STATUSES.has(status);
}

/**
 * Classify swept jobs against persisted alert state (pure).
 *
 * - `checked`: every scheduled job except the watchdog itself.
 * - `unhealthy`: checked jobs whose status is failing/late/unknown.
 * - `newAlerts`: unhealthy jobs with no open episode (no state row, or the
 *   last episode closed with a recovery).
 * - `recoveries`: healthy jobs whose last episode is still open.
 */
export function sweepCronJobs({
  jobs,
  states,
}: {
  jobs: CronJobHealth[];
  states: CronAlertStateRow[];
}): CronWatchdogSweep {
  const stateByKey = new Map(states.map((state) => [state.jobKey, state]));
  const checked = jobs.filter((job) => !job.manualOnly && job.key !== WATCHDOG_JOB_KEY);
  const unhealthy = checked.filter((job) => isAlertableStatus(job.status));
  const newAlerts = unhealthy.filter((job) => {
    const state = stateByKey.get(job.key);
    return !state || state.lastAlertOutcome !== "alerted";
  });
  const recoveries = checked.filter((job) => {
    const state = stateByKey.get(job.key);
    return job.status === "healthy" && state?.lastAlertOutcome === "alerted";
  });
  return { checked, unhealthy, newAlerts, recoveries };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unhealthyLine(job: CronJobHealth, newKeys: ReadonlySet<string>): string {
  const marker = newKeys.has(job.key) ? ", new" : "";
  const detail = job.errorSummary ?? job.healthDetail;
  return `${job.label} [${job.status}${marker}] - ${detail}`;
}

/**
 * Build the single digest email for one sweep: all currently-unhealthy jobs
 * (new episodes marked), recovered jobs, and the /data-health link. Follows
 * the leave-requests notificationText precedent.
 */
export function buildWatchdogEmail({
  unhealthy,
  newAlerts,
  recoveries,
}: {
  unhealthy: CronJobHealth[];
  newAlerts: CronJobHealth[];
  recoveries: CronJobHealth[];
}): { subject: string; text: string; html: string } {
  const newKeys = new Set(newAlerts.map((job) => job.key));
  const subject =
    unhealthy.length > 0
      ? `[BGScheduler] ${unhealthy.length} cron job(s) unhealthy`
      : `[BGScheduler] ${recoveries.length} cron job(s) recovered`;
  const dashboardUrl = `${APP_BASE_URL.replace(/\/$/, "")}/data-health`;

  const text = [
    subject,
    "",
    ...(unhealthy.length
      ? ["Unhealthy jobs:", ...unhealthy.map((job) => `- ${unhealthyLine(job, newKeys)}`), ""]
      : []),
    ...(recoveries.length
      ? ["Recovered jobs:", ...recoveries.map((job) => `- ${job.label} recovered`), ""]
      : []),
    `Open dashboard: ${dashboardUrl}`,
  ].join("\n");

  const unhealthyHtml = unhealthy.length
    ? `<p style="margin:0 0 4px"><strong>Unhealthy jobs</strong></p>
      <ul>
        ${unhealthy
          .map(
            (job) =>
              `<li><strong>${escapeHtml(job.label)}</strong> [${escapeHtml(job.status)}${newKeys.has(job.key) ? ", new" : ""}] - ${escapeHtml(job.errorSummary ?? job.healthDetail)}</li>`,
          )
          .join("")}
      </ul>`
    : "";
  const recoveredHtml = recoveries.length
    ? `<p style="margin:0 0 4px"><strong>Recovered jobs</strong></p>
      <ul>
        ${recoveries.map((job) => `<li><strong>${escapeHtml(job.label)}</strong> recovered</li>`).join("")}
      </ul>`
    : "";
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;color:#0f172a">
      <h2 style="margin:0 0 12px">Cron job health alert</h2>
      ${unhealthyHtml}
      ${recoveredHtml}
      <p><a href="${dashboardUrl}">Open Data Health dashboard</a></p>
      <p style="color:#64748b;font-size:12px">Sent by the cron watchdog. One alert per job per failure episode.</p>
    </div>
  `;

  return { subject, text, html };
}

async function loadAdminEmails(db: Database): Promise<string[]> {
  const rows = await db
    .select({ email: schema.adminUsers.email })
    .from(schema.adminUsers)
    .orderBy(asc(schema.adminUsers.email));
  return [...new Set(rows.map((row) => row.email.trim().toLowerCase()).filter(Boolean))];
}

/**
 * drizzle-orm wraps every neon-http query error in a DrizzleQueryError whose
 * message is `Failed query: <sql>`; the Postgres "relation does not exist"
 * detail lives on `error.cause`. Mirror isMissingTutorProfileTable
 * (src/lib/tutor-business-profiles.ts) and check both layers plus pg code
 * 42P01 so the fail-safe actually fires before the migration is applied.
 */
function isMissingAlertStateTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = typeof error === "object" && error && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  const causeMessage = cause instanceof Error ? cause.message : String(cause ?? "");
  const causeCode = typeof cause === "object" && cause && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : "";
  return (
    message.includes("cron_alert_state") ||
    causeMessage.includes("cron_alert_state")
  ) && (
    message.includes("does not exist") ||
    causeMessage.includes("does not exist") ||
    message.includes("42P01") ||
    causeCode === "42P01"
  );
}

/**
 * Atomically claim the single-flight sweep lock in one conditional upsert:
 * the INSERT takes the lock when no sentinel row exists, the DO UPDATE only
 * fires when the previous holder released it or went stale, and RETURNING
 * reports whether either path won. Concurrent sweeps therefore cannot both
 * read alert state before one of them writes it (duplicate alert emails).
 */
async function claimSweepLock(db: Database, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - SWEEP_LOCK_STALE_MS);
  const token = `sweep:${now.toISOString()}`;
  const claimed = await db
    .insert(schema.cronAlertState)
    .values({
      jobKey: SWEEP_LOCK_KEY,
      episodeKey: token,
      lastStatus: "running",
      lastAlertOutcome: "sweep_lock",
      lastAlertedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.cronAlertState.jobKey,
      set: {
        episodeKey: token,
        lastStatus: "running",
        lastAlertedAt: now,
        updatedAt: now,
      },
      setWhere: sql`${schema.cronAlertState.lastStatus} <> 'running' OR ${schema.cronAlertState.updatedAt} < ${staleBefore}`,
    })
    .returning({ jobKey: schema.cronAlertState.jobKey });
  return claimed.length > 0;
}

/** Release only our own claim (episodeKey match guards stale-reclaim races). */
async function releaseSweepLock(db: Database, now: Date): Promise<void> {
  const token = `sweep:${now.toISOString()}`;
  try {
    await db
      .update(schema.cronAlertState)
      .set({ lastStatus: "released", updatedAt: new Date() })
      .where(
        and(
          eq(schema.cronAlertState.jobKey, SWEEP_LOCK_KEY),
          eq(schema.cronAlertState.episodeKey, token),
        ),
      );
  } catch (error) {
    // Never mask the sweep's own outcome; a stuck lock self-heals via the
    // stale window on the next claim.
    console.error("Cron watchdog failed to release the sweep lock", error);
  }
}

/**
 * Run one watchdog sweep.
 *
 * 1. Load every job's health via the shared /data-health derivation.
 * 2. Claim the single-flight sweep lock; if the cron_alert_state table is
 *    missing, fail safe with no alerting (un-deduped alerts every sweep
 *    would be spam); if another sweep holds the lock, skip this one.
 * 3. Load persisted alert state and classify new alert episodes and
 *    recoveries against it.
 * 4. If anything changed, email the digest to all full-access admin_users
 *    recipients.
 * 5. Persist episode state only after at least one delivery succeeded, so a
 *    total delivery failure is retried on the next sweep.
 * 6. Release the lock.
 *
 * @returns counts for the route's JSON summary.
 */
export async function runCronWatchdog(
  db: Database,
  options: RunCronWatchdogOptions = {},
): Promise<CronWatchdogSummary> {
  const now = options.now ?? new Date();
  const jobs = await (options.loadJobs ?? getCronJobsHealth)(now);

  let lockClaimed: boolean;
  try {
    lockClaimed = await claimSweepLock(db, now);
  } catch (error) {
    if (!isMissingAlertStateTable(error)) throw error;
    console.error(
      "cron_alert_state table is unavailable; watchdog alerting is disabled until the migration runs.",
    );
    const sweep = sweepCronJobs({ jobs, states: [] });
    return {
      checked: sweep.checked.length,
      unhealthy: sweep.unhealthy.length,
      alertsSent: 0,
      recoveries: 0,
      emailRecipients: 0,
      skippedReason: "cron_alert_state table unavailable",
    };
  }

  if (!lockClaimed) {
    const sweep = sweepCronJobs({ jobs, states: [] });
    return {
      checked: sweep.checked.length,
      unhealthy: sweep.unhealthy.length,
      alertsSent: 0,
      recoveries: 0,
      emailRecipients: 0,
      skippedReason: "another sweep is in flight",
    };
  }

  try {
    return await runLockedSweep(db, now, jobs, options);
  } finally {
    await releaseSweepLock(db, now);
  }
}

async function runLockedSweep(
  db: Database,
  now: Date,
  jobs: CronJobHealth[],
  options: RunCronWatchdogOptions,
): Promise<CronWatchdogSummary> {
  const allStates = await db.select().from(schema.cronAlertState);
  const states = allStates.filter((state) => state.jobKey !== SWEEP_LOCK_KEY);

  const sweep = sweepCronJobs({ jobs, states });
  const base = { checked: sweep.checked.length, unhealthy: sweep.unhealthy.length };

  if (sweep.newAlerts.length === 0 && sweep.recoveries.length === 0) {
    return { ...base, alertsSent: 0, recoveries: 0, emailRecipients: 0, skippedReason: null };
  }

  const recipients = await loadAdminEmails(db);
  if (recipients.length === 0) {
    console.error("Cron watchdog found no admin recipients; episode state left unmarked for retry.");
    return { ...base, alertsSent: 0, recoveries: 0, emailRecipients: 0, skippedReason: "no admin recipients" };
  }

  const content = buildWatchdogEmail({
    unhealthy: sweep.unhealthy,
    newAlerts: sweep.newAlerts,
    recoveries: sweep.recoveries,
  });
  const sender = options.sender ?? createAppsScriptScheduleEmailSender();
  let sentCount = 0;
  for (const recipient of recipients) {
    try {
      await sender.sendEmail({
        to: recipient,
        subject: content.subject,
        text: content.text,
        html: content.html,
        idempotencyKey: `cron-watchdog:${now.toISOString()}:${recipient}`.slice(0, 256),
      });
      sentCount += 1;
    } catch (error) {
      console.error("Cron watchdog email send failed", error);
    }
  }

  if (sentCount === 0) {
    console.error("Cron watchdog could not deliver to any recipient; episode state left unmarked for retry.");
    return { ...base, alertsSent: 0, recoveries: 0, emailRecipients: 0, skippedReason: "email delivery failed" };
  }

  for (const job of sweep.newAlerts) {
    const episode = {
      episodeKey: `${job.key}:${now.toISOString()}`,
      lastStatus: job.status,
      lastAlertOutcome: "alerted",
      lastAlertedAt: now,
      errorSummary: job.errorSummary ?? null,
      updatedAt: now,
    };
    await db
      .insert(schema.cronAlertState)
      .values({ jobKey: job.key, ...episode })
      .onConflictDoUpdate({ target: schema.cronAlertState.jobKey, set: episode });
  }

  for (const job of sweep.recoveries) {
    await db
      .update(schema.cronAlertState)
      .set({
        lastStatus: job.status,
        lastAlertOutcome: "recovered",
        lastRecoveredAt: now,
        updatedAt: now,
      })
      .where(eq(schema.cronAlertState.jobKey, job.key));
  }

  return {
    ...base,
    alertsSent: sweep.newAlerts.length,
    recoveries: sweep.recoveries.length,
    emailRecipients: sentCount,
    skippedReason: null,
  };
}
