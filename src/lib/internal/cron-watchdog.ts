// Cron watchdog — sweeps every registered cron job using the same health
// derivation as /data-health, records failure episodes, and emails one daily
// digest.
//
// Episode bookkeeping: every 30-minute sweep persists episode transitions in
// cron_alert_state without sending anything. A job's episode opens when it
// first turns unhealthy (lastAlertOutcome = "alerted", lastAlertedAt = open
// time) and closes when it is healthy again (lastAlertOutcome = "recovered",
// lastRecoveredAt), which re-arms the next episode.
//
// Daily digest (WD-DIGEST-01): once per Bangkok day, on the first sweep at or
// after 08:00 Bangkok, one email goes to CRON_WATCHDOG_ALERT_EMAILS (default
// kevhsh7@gmail.com) listing the currently unhealthy jobs plus the episodes
// opened and closed in the last 24 hours. Until 2026-10-02 every sweep that
// opened or closed an episode emailed all full-access admins; with 7-9 jobs
// flapping that alone was ~100 emails/day and exhausted the relay quota.
// The digest's own state lives in the DAILY_DIGEST_KEY sentinel row. A
// pre-acceptance rejection (ScheduleEmailRejection) leaves the day unsent so
// the next sweep retries; an uncertain outcome never resends.
//
// The private weekend-check job is unchanged: it alerts its single private
// recipient immediately, per episode, and never enters the shared digest.

import { and, eq, sql } from "drizzle-orm";
import { monitorNightlyReminders } from "@/lib/post-class-feedback/reminder-monitor";
import { weekendAlertRecipient, WEEKEND_CHECK_JOB_KEY } from "@/lib/classrooms/weekend-config";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  ScheduleEmailRejection,
  type ScheduleEmailSender,
} from "@/lib/classrooms/schedule-email";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { getCronJobDefinition } from "@/lib/data-health/cron-registry";
import { pruneCronInvocations } from "@/lib/data-health/cron-retention";
import { getCronJobsHealth } from "@/lib/data-health/dashboard";
import type { CronJobHealth, CronJobStatus } from "@/lib/data-health/types";
import { APP_BASE_URL } from "@/lib/leave-requests/config";
import {
  loadFeedbackDeadlineCoverage,
  POST_CLASS_COLLECTION_JOB_KEY,
  type FeedbackDeadlineCoverage,
} from "@/lib/post-class-feedback/deadline-coverage";
import {
  loadPayoutWindowStaleness,
  PAYOUT_ACCRUAL_JOB_KEY,
  type PayoutWindowStaleness,
} from "@/lib/post-class-feedback/payout-window-health";

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

/**
 * Sentinel cron_alert_state row carrying the daily digest's state:
 * `episodeKey = "digest:<Bangkok date>"` once that day's digest is settled
 * (sent, empty, or uncertain). Invisible to classification like the lock.
 */
export const DAILY_DIGEST_KEY = "__watchdog_daily_digest";

/** First Bangkok hour at which the daily digest may go out. */
export const DAILY_DIGEST_HOUR_BANGKOK = 8;

/** Used when CRON_WATCHDOG_ALERT_EMAILS is unset or empty. */
export const DEFAULT_WATCHDOG_RECIPIENT = "kevhsh7@gmail.com";

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  /** Failure episodes opened by this sweep (no longer one email each). */
  alertsSent: number;
  /** Failure episodes closed by this sweep. */
  recoveries: number;
  emailRecipients: number;
  /** True when this sweep settled the day's digest by sending it. */
  digestSent: boolean;
  skippedReason: string | null;
  /** Rows removed from cron_invocations by the retention sweep. */
  invocationsPruned: number;
}

/** The alerting sweep's own result; retention is bolted on by the caller. */
type CronWatchdogSweepSummary = Omit<CronWatchdogSummary, "invocationsPruned">;

export interface RunCronWatchdogOptions {
  now?: Date;
  sender?: ScheduleEmailSender;
  /** Digest recipients; defaults to watchdogAlertRecipients(). */
  recipients?: string[];
  loadJobs?: (now: Date) => Promise<CronJobHealth[]>;
  loadPayoutWindow?: (db: Database, now: Date) => Promise<PayoutWindowStaleness | null>;
  loadDeadlineCoverage?: (db: Database, now: Date) => Promise<FeedbackDeadlineCoverage | null>;
  pruneInvocations?: (db: Database, now: Date) => Promise<number>;
}

/**
 * Synthetic swept entry for the payout finalize window. Not a cron route: the
 * accrual cron firing on time says nothing about whether the window it was
 * supposed to close actually reached `published`, and that gap used to be
 * completely silent. Riding the sweep gets episode dedup, the digest email,
 * and the recovery notice for free.
 */
export const PAYOUT_WINDOW_JOB_KEY = "post_class_payout_window";

/** Project a staleness verdict onto the shape the sweep classifies. */
export function payoutWindowJobHealth(staleness: PayoutWindowStaleness): CronJobHealth {
  const accrual = getCronJobDefinition(PAYOUT_ACCRUAL_JOB_KEY);
  return {
    key: PAYOUT_WINDOW_JOB_KEY,
    label: "Payout Window Finalize",
    feature: "Class Feedback",
    path: accrual?.path ?? "/api/internal/post-class-feedback/payout-accrual",
    schedule: accrual?.schedule ?? null,
    cadenceLabel: "Per payout window",
    maxDurationSeconds: accrual?.maxDurationSeconds ?? 800,
    manualOnly: false,
    dangerous: true,
    status: staleness.stale ? "failing" : "healthy",
    proof: "inferred",
    proofLabel: "Payout run status",
    lastSeenAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    nextExpectedAt: null,
    lastExpectedAt: staleness.windowEnd,
    lateAfterAt: null,
    durationMs: null,
    responseStatus: null,
    errorSummary: staleness.stale ? staleness.detail : null,
    healthDetail: staleness.detail,
    latestInvocation: null,
    recentInvocations: [],
    // A synthetic health row has no Run action of its own (fail-closed).
    canRunManually: false,
  };
}

/**
 * Never let the payout check take the watchdog down: this is a live 30-minute
 * cron whose job is reporting on everything else, so a payout-side failure
 * (missing table on an un-migrated database, a query error) degrades to "no
 * payout entry this sweep" rather than a failed sweep.
 */
async function loadPayoutWindowJob(
  db: Database,
  now: Date,
  options: RunCronWatchdogOptions,
): Promise<CronJobHealth | null> {
  try {
    const staleness = await (options.loadPayoutWindow ?? loadPayoutWindowStaleness)(db, now);
    return staleness ? payoutWindowJobHealth(staleness) : null;
  } catch (error) {
    console.error("Cron watchdog could not evaluate payout window staleness", error);
    return null;
  }
}

/**
 * Synthetic swept entry for post-deadline assessment coverage (FU1). Not a
 * cron route: the collection cron firing on time says nothing about whether
 * classes that crossed their feedback deadline were ever re-observed after it,
 * and without that assessment a late or short submission is never charged.
 */
export const DEADLINE_COVERAGE_JOB_KEY = "post_class_deadline_coverage";

/** Project a coverage verdict onto the shape the sweep classifies. */
export function deadlineCoverageJobHealth(coverage: FeedbackDeadlineCoverage): CronJobHealth {
  const collection = getCronJobDefinition(POST_CLASS_COLLECTION_JOB_KEY);
  return {
    key: DEADLINE_COVERAGE_JOB_KEY,
    label: "Feedback Deadline Coverage",
    feature: "Class Feedback",
    path: collection?.path ?? "/api/internal/sync-post-class-feedback",
    schedule: collection?.schedule ?? null,
    cadenceLabel: "Per feedback deadline",
    maxDurationSeconds: collection?.maxDurationSeconds ?? 800,
    manualOnly: false,
    dangerous: false,
    status: coverage.stale ? "failing" : "healthy",
    proof: "inferred",
    proofLabel: "Post-deadline assessment coverage",
    lastSeenAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    nextExpectedAt: null,
    lastExpectedAt: coverage.oldestDeadlineAt?.toISOString() ?? null,
    lateAfterAt: null,
    durationMs: null,
    responseStatus: null,
    errorSummary: coverage.stale ? coverage.detail : null,
    healthDetail: coverage.detail,
    latestInvocation: null,
    recentInvocations: [],
    // A synthetic health row has no Run action of its own (fail-closed).
    canRunManually: false,
  };
}

/**
 * Same containment as the payout-window entry: a coverage-side failure (a
 * query error, a missing aggregate row) degrades to "no entry this sweep"
 * rather than a failed sweep.
 */
async function loadDeadlineCoverageJob(
  db: Database,
  now: Date,
  options: RunCronWatchdogOptions,
): Promise<CronJobHealth | null> {
  try {
    const coverage = await (options.loadDeadlineCoverage ?? loadFeedbackDeadlineCoverage)(db, now);
    return coverage ? deadlineCoverageJobHealth(coverage) : null;
  } catch (error) {
    console.error("Cron watchdog could not evaluate feedback deadline coverage", error);
    return null;
  }
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
  digestDate,
}: {
  unhealthy: CronJobHealth[];
  newAlerts: CronJobHealth[];
  recoveries: CronJobHealth[];
  /** Bangkok date for the daily digest; omitted for the private per-episode alert. */
  digestDate?: string;
}): { subject: string; text: string; html: string } {
  const newKeys = new Set(newAlerts.map((job) => job.key));
  const prefix = digestDate ? `[BGScheduler] Daily cron digest ${digestDate}: ` : "[BGScheduler] ";
  const subject =
    unhealthy.length > 0
      ? `${prefix}${unhealthy.length} cron job(s) unhealthy`
      : `${prefix}${recoveries.length} cron job(s) recovered`;
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
    ...(digestDate ? ['"new" marks episodes opened in the last 24 hours.', ""] : []),
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
      <h2 style="margin:0 0 12px">${digestDate ? `Daily cron health digest — ${digestDate}` : "Cron job health alert"}</h2>
      ${unhealthyHtml}
      ${recoveredHtml}
      <p><a href="${dashboardUrl}">Open Data Health dashboard</a></p>
      <p style="color:#64748b;font-size:12px">${digestDate ? "Sent by the cron watchdog once a day. &quot;new&quot; marks episodes opened in the last 24 hours." : "Sent by the cron watchdog. One alert per job per failure episode."}</p>
    </div>
  `;

  return { subject, text, html };
}

/**
 * Daily digest recipients from CRON_WATCHDOG_ALERT_EMAILS (comma or space
 * separated), defaulting to Kevin. Deliberately not admin_users: the digest
 * is an operator signal, and fanning it out per admin is what exhausted the
 * email quota.
 */
export function watchdogAlertRecipients(env: { readonly [name: string]: string | undefined } = process.env): string[] {
  const configured = (env.CRON_WATCHDOG_ALERT_EMAILS ?? "")
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return configured.length ? [...new Set(configured)] : [DEFAULT_WATCHDOG_RECIPIENT];
}

/** Bangkok calendar date and hour for `now` (Asia/Bangkok has no DST). */
export function bangkokClock(now: Date): { date: string; hour: number } {
  const shifted = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
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
 * 1. Load every job's health via the shared /data-health derivation, plus two
 *    synthetic entries: the payout-window entry when the accrual cron is
 *    scheduled, and the feedback deadline coverage entry when the collection
 *    cron is scheduled.
 * 2. Claim the single-flight sweep lock; if the cron_alert_state table is
 *    missing, fail safe with no alerting (un-deduped alerts every sweep
 *    would be spam); if another sweep holds the lock, skip this one.
 * 3. Load persisted alert state and classify new alert episodes and
 *    recoveries against it.
 * 4. Persist episode transitions (no email). The private weekend job still
 *    alerts its own recipient per episode.
 * 5. Once per Bangkok day at or after 08:00, email the daily digest
 *    (WD-DIGEST-01) to watchdogAlertRecipients().
 * 6. Release the lock.
 *
 * The cron_invocations retention sweep rides along first, in its own
 * try/catch: it is bookkeeping, and a failed prune must never suppress an
 * alert digest.
 *
 * @returns counts for the route's JSON summary.
 */
export async function runCronWatchdog(
  db: Database,
  options: RunCronWatchdogOptions = {},
): Promise<CronWatchdogSummary> {
  const now = options.now ?? new Date();

  let invocationsPruned = 0;
  try {
    invocationsPruned = await (options.pruneInvocations ?? pruneCronInvocations)(db, now);
  } catch (error) {
    console.error("Cron watchdog failed to prune cron_invocations", error);
  }

  const summary = await runWatchdogSweep(db, now, options);
  return { ...summary, invocationsPruned };
}

async function runWatchdogSweep(
  db: Database,
  now: Date,
  options: RunCronWatchdogOptions,
): Promise<CronWatchdogSweepSummary> {
  const registryJobs = await (options.loadJobs ?? getCronJobsHealth)(now);
  const payoutWindow = await loadPayoutWindowJob(db, now, options);
  const deadlineCoverage = await loadDeadlineCoverageJob(db, now, options);
  const jobs = [
    ...registryJobs,
    ...(payoutWindow ? [payoutWindow] : []),
    ...(deadlineCoverage ? [deadlineCoverage] : []),
  ];

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
      digestSent: false,
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
      digestSent: false,
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
): Promise<CronWatchdogSweepSummary> {
  const nightly = jobs.find(job => job.key === "post_class_feedback_nightly");
  const monitored = nightly ? await monitorNightlyReminders(db, now, nightly) : null;
  const result = await runEmailSweep(db, now, jobs.filter(job => job.key !== "post_class_feedback_nightly"), options);
  return { ...result, checked: result.checked + (nightly ? 1 : 0), unhealthy: result.unhealthy + (monitored?.failing ? 1 : 0) };
}

async function runEmailSweep(db: Database, now: Date, jobs: CronJobHealth[], options: RunCronWatchdogOptions): Promise<CronWatchdogSweepSummary> {
  const privateJobs = jobs.filter(job => job.key === WEEKEND_CHECK_JOB_KEY);
  if (!privateJobs.length) return runSharedSweep(db, now, jobs, options);
  const shared = await runSharedSweep(db, now, jobs.filter(job => job.key !== WEEKEND_CHECK_JOB_KEY), options);
  let recipients: string[] = [];
  try { recipients = [weekendAlertRecipient()]; }
  catch { console.error("Weekend watchdog recipient is not configured; private findings will not enter shared admin mail."); }
  const privateResult = await runRecipientSweep(db, now, privateJobs, options, recipients);
  return { checked: shared.checked + privateResult.checked, unhealthy: shared.unhealthy + privateResult.unhealthy,
    alertsSent: shared.alertsSent + privateResult.alertsSent, recoveries: shared.recoveries + privateResult.recoveries,
    emailRecipients: shared.emailRecipients + privateResult.emailRecipients,
    digestSent: shared.digestSent,
    skippedReason: [shared.skippedReason, privateResult.skippedReason].filter(Boolean).join("; ") || null };
}

/** Sentinel rows are never job episodes. */
function episodeStates(rows: CronAlertStateRow[]): CronAlertStateRow[] {
  return rows.filter((state) => state.jobKey !== SWEEP_LOCK_KEY && state.jobKey !== DAILY_DIGEST_KEY);
}

async function upsertAlertState(db: Database, jobKey: string, row: Omit<CronAlertStateRow, "jobKey" | "lastAlertedAt" | "lastRecoveredAt" | "errorSummary"> & Partial<CronAlertStateRow>) {
  await db
    .insert(schema.cronAlertState)
    .values({ jobKey, ...row })
    .onConflictDoUpdate({ target: schema.cronAlertState.jobKey, set: row });
}

/**
 * Shared jobs: record episode transitions every sweep, email nothing, and
 * send the once-a-day digest when it is due.
 */
async function runSharedSweep(
  db: Database,
  now: Date,
  jobs: CronJobHealth[],
  options: RunCronWatchdogOptions,
): Promise<CronWatchdogSweepSummary> {
  const allStates = await db.select().from(schema.cronAlertState);
  const states = episodeStates(allStates);
  const sweep = sweepCronJobs({ jobs, states });

  for (const job of sweep.newAlerts) {
    await upsertAlertState(db, job.key, {
      episodeKey: `${job.key}:${now.toISOString()}`,
      lastStatus: job.status,
      lastAlertOutcome: "alerted",
      lastAlertedAt: now,
      errorSummary: job.errorSummary ?? null,
      updatedAt: now,
    });
  }
  for (const job of sweep.recoveries) {
    await db
      .update(schema.cronAlertState)
      .set({ lastStatus: job.status, lastAlertOutcome: "recovered", lastRecoveredAt: now, errorSummary: null, updatedAt: now })
      .where(eq(schema.cronAlertState.jobKey, job.key));
  }

  const base = {
    checked: sweep.checked.length,
    unhealthy: sweep.unhealthy.length,
    alertsSent: sweep.newAlerts.length,
    recoveries: sweep.recoveries.length,
  };
  const digest = await sendDailyDigestIfDue(db, now, jobs, sweep, states,
    allStates.find((state) => state.jobKey === DAILY_DIGEST_KEY), options);
  return { ...base, ...digest };
}

/**
 * WD-DIGEST-01: one digest per Bangkok day, first sweep at or after 08:00.
 * Covers currently-unhealthy jobs, episodes opened in the last 24 h ("new"),
 * and episodes closed in the last 24 h.
 */
async function sendDailyDigestIfDue(
  db: Database,
  now: Date,
  jobs: CronJobHealth[],
  sweep: CronWatchdogSweep,
  states: CronAlertStateRow[],
  digestState: CronAlertStateRow | undefined,
  options: RunCronWatchdogOptions,
): Promise<{ emailRecipients: number; digestSent: boolean; skippedReason: string | null }> {
  const clock = bangkokClock(now);
  const settledKey = `digest:${clock.date}`;
  const notDue = { emailRecipients: 0, digestSent: false, skippedReason: null };
  if (clock.hour < DAILY_DIGEST_HOUR_BANGKOK || digestState?.episodeKey === settledKey) return notDue;

  // Reach back to the previous settled digest when that is older than 24 h
  // (a late or retried send), so no episode slips between two digests.
  // lastAlertedAt on the sentinel is the last settled send; a failed attempt
  // preserves it.
  const lastSettledAt = digestState?.lastAlertedAt?.getTime();
  const since = Math.min(now.getTime() - DIGEST_WINDOW_MS, lastSettledAt ?? Infinity);
  const within = (at: Date | null | undefined) => !!at && at.getTime() >= since;
  const openedKeys = new Set([
    ...sweep.newAlerts.map((job) => job.key),
    ...states.filter((state) => within(state.lastAlertedAt)).map((state) => state.jobKey),
  ]);
  const recoveredKeys = new Set([
    ...sweep.recoveries.map((job) => job.key),
    ...states.filter((state) => within(state.lastRecoveredAt)).map((state) => state.jobKey),
  ]);
  const unhealthyKeys = new Set(sweep.unhealthy.map((job) => job.key));
  const opened = sweep.checked.filter((job) => openedKeys.has(job.key));
  // A job that recovered and then failed again is listed as unhealthy, not recovered.
  const recovered = sweep.checked.filter((job) => recoveredKeys.has(job.key) && !unhealthyKeys.has(job.key));

  async function settle(outcome: string, errorSummary: string | null, episodeKey = settledKey) {
    await upsertAlertState(db, DAILY_DIGEST_KEY, {
      episodeKey,
      lastStatus: outcome,
      lastAlertOutcome: outcome,
      lastAlertedAt: outcome === "digest_failed" ? digestState?.lastAlertedAt ?? null : now,
      errorSummary,
      updatedAt: now,
    });
  }

  if (sweep.unhealthy.length === 0 && recovered.length === 0) {
    await settle("digest_empty", null);
    return notDue;
  }

  const recipients = options.recipients ?? watchdogAlertRecipients();
  const content = buildWatchdogEmail({
    unhealthy: sweep.unhealthy,
    newAlerts: opened,
    recoveries: recovered,
    digestDate: clock.date,
  });
  const sender = options.sender ?? createOutboundEmailSender("primary", { strictOutcome: true });
  let accepted = 0;
  let uncertain = 0;
  for (const recipient of recipients) {
    try {
      await sender.sendEmail({
        to: recipient,
        subject: content.subject,
        text: content.text,
        html: content.html,
        idempotencyKey: `cron-watchdog-digest:${clock.date}:${recipient}`.slice(0, 256),
      });
      accepted += 1;
    } catch (error) {
      if (!(error instanceof ScheduleEmailRejection)) uncertain += 1;
      console.error("Cron watchdog digest send failed", error);
    }
  }

  if (accepted === 0 && uncertain === 0) {
    // Every recipient rejected before acceptance: leave the day unsettled so
    // the next sweep retries.
    await settle("digest_failed", "No recipient accepted the daily digest. The next sweep will retry.", `digest-failed:${clock.date}`);
    return { emailRecipients: 0, digestSent: false, skippedReason: "email delivery failed" };
  }
  const failed = recipients.length - accepted;
  await settle("digest_sent", failed > 0
    ? `Digest delivery: ${failed} of ${recipients.length} recipients were not confirmed; they will not be retried today.`
    : null);
  // Uncertain outcomes settle the day (never resend) but are not claimed as sent.
  return { emailRecipients: accepted, digestSent: accepted > 0, skippedReason: accepted > 0 ? null : "digest outcome uncertain" };
}

/** The private weekend job: immediate per-episode alerts to its own recipient. */
async function runRecipientSweep(db: Database, now: Date, jobs: CronJobHealth[], options: RunCronWatchdogOptions,
  privateRecipients: string[]): Promise<CronWatchdogSweepSummary> {
  const allStates = await db.select().from(schema.cronAlertState);
  const states = episodeStates(allStates);

  const sweep = sweepCronJobs({ jobs, states });
  const base = { checked: sweep.checked.length, unhealthy: sweep.unhealthy.length };

  if (sweep.newAlerts.length === 0 && sweep.recoveries.length === 0) {
    return { ...base, alertsSent: 0, recoveries: 0, emailRecipients: 0, digestSent: false, skippedReason: null };
  }

  async function recordDeliveryFailure(detail: string) {
    for (const job of [...sweep.newAlerts, ...sweep.recoveries]) {
      const prior = states.find((row) => row.jobKey === job.key);
      const row = { episodeKey: prior?.episodeKey ?? `${job.key}:${now.toISOString()}`,
        lastStatus: job.status, lastAlertOutcome: prior?.lastAlertOutcome ?? "delivery_failed",
        errorSummary: `Alert delivery failure: ${detail}`, updatedAt: now };
      await db.insert(schema.cronAlertState).values({ jobKey: job.key, ...row })
        .onConflictDoUpdate({ target: schema.cronAlertState.jobKey, set: row });
    }
  }
  const recipients = privateRecipients;
  if (recipients.length === 0) {
    await recordDeliveryFailure("No admin recipients are configured.");
    console.error("Cron watchdog found no admin recipients; episode state left unmarked for retry.");
    return { ...base, alertsSent: 0, recoveries: 0, emailRecipients: 0, digestSent: false, skippedReason: "no admin recipients" };
  }

  const content = buildWatchdogEmail({
    unhealthy: sweep.unhealthy,
    newAlerts: sweep.newAlerts,
    recoveries: sweep.recoveries,
  });
  const sender = options.sender ?? createOutboundEmailSender();
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
    await recordDeliveryFailure("No recipient accepted the alert. The next sweep will retry.");
    console.error("Cron watchdog could not deliver to any recipient; episode state left unmarked for retry.");
    return { ...base, alertsSent: 0, recoveries: 0, emailRecipients: 0, digestSent: false, skippedReason: "email delivery failed" };
  }
  if (sentCount < recipients.length) {
    // Partial delivery still closes out the episode below — see the
    // partial-delivery tradeoff note in the module header.
    console.error(
      `Cron watchdog delivered to ${sentCount}/${recipients.length} recipients; failed recipients will not be retried for this episode.`,
    );
  }

  for (const job of sweep.newAlerts) {
    const episode = {
      episodeKey: `${job.key}:${now.toISOString()}`,
      lastStatus: job.status,
      lastAlertOutcome: "alerted",
      lastAlertedAt: now,
      errorSummary: sentCount < recipients.length ? `Alert delivery failure: ${recipients.length - sentCount} of ${recipients.length} recipients failed.` : job.errorSummary ?? null,
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
        errorSummary: sentCount < recipients.length ? `Alert delivery failure: ${recipients.length - sentCount} recovery recipients failed.` : null,
        updatedAt: now,
      })
      .where(eq(schema.cronAlertState.jobKey, job.key));
  }

  return {
    ...base,
    alertsSent: sweep.newAlerts.length,
    recoveries: sweep.recoveries.length,
    emailRecipients: sentCount,
    digestSent: false,
    skippedReason: null,
  };
}
