import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { ScheduleEmailRejection, type ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import type { CronJobHealth } from "@/lib/data-health/types";
import type { FeedbackDeadlineCoverage } from "@/lib/post-class-feedback/deadline-coverage";
import type { PayoutWindowStaleness } from "@/lib/post-class-feedback/payout-window-health";
import {
  bangkokClock,
  buildWatchdogEmail,
  DAILY_DIGEST_KEY,
  DEADLINE_COVERAGE_JOB_KEY,
  PAYOUT_WINDOW_JOB_KEY,
  runCronWatchdog,
  sweepCronJobs,
  SWEEP_LOCK_KEY,
  watchdogAlertRecipients,
  type CronAlertStateRow,
} from "@/lib/internal/cron-watchdog";

// ── Fixtures ──────────────────────────────────────────────────────────────

// 10:07 Bangkok: past the 08:00 digest hour.
const NOW = new Date("2026-06-10T03:07:00.000Z");
// 07:07 Bangkok: before the digest hour.
const BEFORE_DIGEST_HOUR = new Date("2026-06-10T00:07:00.000Z");

function jobHealth(overrides: Partial<CronJobHealth> & { key: string }): CronJobHealth {
  return {
    label: overrides.key,
    feature: "Test",
    path: `/api/internal/${overrides.key}`,
    schedule: "*/30 * * * *",
    cadenceLabel: "Every 30 min",
    maxDurationSeconds: 300,
    manualOnly: false,
    dangerous: false,
    status: "healthy",
    proof: "direct",
    proofLabel: "Direct cron audit",
    lastSeenAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    nextExpectedAt: null,
    lastExpectedAt: null,
    lateAfterAt: null,
    durationMs: null,
    responseStatus: null,
    errorSummary: null,
    healthDetail: "Cron audit confirms this route fired recently.",
    latestInvocation: null,
    recentInvocations: [],
    canRunManually: true,
    ...overrides,
  };
}

function alertState(overrides: Partial<CronAlertStateRow> & { jobKey: string }): CronAlertStateRow {
  return {
    episodeKey: `${overrides.jobKey}:2026-06-10T02:37:00.000Z`,
    lastStatus: "failing",
    lastAlertOutcome: "alerted",
    lastAlertedAt: new Date("2026-06-10T02:37:00.000Z"),
    lastRecoveredAt: null,
    errorSummary: null,
    updatedAt: new Date("2026-06-10T02:37:00.000Z"),
    ...overrides,
  };
}

/** The day's digest already went out, so a sweep only records episodes. */
function settledDigest(date = "2026-06-10"): CronAlertStateRow {
  return alertState({
    jobKey: DAILY_DIGEST_KEY,
    episodeKey: `digest:${date}`,
    lastStatus: "digest_sent",
    lastAlertOutcome: "digest_sent",
  });
}

// ── Fake db ───────────────────────────────────────────────────────────────
//
// cron-watchdog.ts uses the Drizzle fluent builder directly, so the tests
// stand up a small chainable fake. Reads are routed by table reference;
// writes are recorded so the episode bookkeeping can be asserted.

interface FakeDbState {
  adminEmails: string[];
  alertStates: CronAlertStateRow[];
  alertStateTableError: Error | null;
  lockAvailable: boolean;
  lockClaims: Array<Record<string, unknown>>;
  lockReleases: Array<Record<string, unknown>>;
  upserts: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }>;
  digestUpserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

function freshState(overrides: Partial<FakeDbState> = {}): FakeDbState {
  return {
    adminEmails: ["a@x.com", "b@x.com"],
    alertStates: [],
    alertStateTableError: null,
    lockAvailable: true,
    lockClaims: [],
    lockReleases: [],
    upserts: [],
    digestUpserts: [],
    updates: [],
    ...overrides,
  };
}

/**
 * What drizzle-orm 0.45 + neon-http actually throws for a missing table: a
 * DrizzleQueryError-shaped wrapper whose message is `Failed query: <sql>`
 * (no "does not exist") with the Postgres relation error on `cause`.
 */
function drizzleMissingTableError(): Error {
  const cause = Object.assign(
    new Error('relation "cron_alert_state" does not exist'),
    { code: "42P01" },
  );
  return new Error(
    'Failed query: select "job_key", "episode_key" from "cron_alert_state"\nparams: ',
    { cause },
  );
}

function makeFakeDb(state: FakeDbState): Database {
  function rowsFor(table: unknown): Promise<unknown[]> {
    if (table === schema.adminUsers) {
      return Promise.resolve(state.adminEmails.map((email) => ({ email })));
    }
    if (table === schema.cronAlertState) {
      if (state.alertStateTableError) {
        return Promise.reject(state.alertStateTableError);
      }
      return Promise.resolve(state.alertStates);
    }
    return Promise.resolve([]);
  }

  const db = {
    select() {
      return {
        from(table: unknown) {
          const chain = {
            where: () => chain,
            orderBy: () => rowsFor(table),
            limit: () => rowsFor(table),
            then(resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
              return rowsFor(table).then(resolve, reject);
            },
          };
          return chain;
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          return {
            onConflictDoUpdate(config: { set: Record<string, unknown> }) {
              const isLockClaim = values.jobKey === SWEEP_LOCK_KEY;
              if (table === schema.cronAlertState && values.jobKey === DAILY_DIGEST_KEY) {
                state.digestUpserts.push(values);
              } else if (table === schema.cronAlertState && !isLockClaim) {
                state.upserts.push({ values, set: config.set });
              }
              return {
                // Lock claims call .returning(); a row back means we won it.
                returning() {
                  if (state.alertStateTableError) {
                    return Promise.reject(state.alertStateTableError);
                  }
                  if (isLockClaim) state.lockClaims.push(values);
                  return Promise.resolve(state.lockAvailable ? [{ jobKey: values.jobKey }] : []);
                },
                // Episode upserts await the builder directly.
                then(resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
                  return Promise.resolve([]).then(resolve, reject);
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              if (table === schema.cronAlertState) {
                if (values.lastStatus === "released") {
                  state.lockReleases.push(values);
                } else {
                  state.updates.push(values);
                }
              }
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };
  return db as unknown as Database;
}

function makeSender(impl?: ScheduleEmailSender["sendEmail"]): ScheduleEmailSender {
  return { sendEmail: vi.fn(impl ?? (async () => ({ id: "provider-msg-1" }))) };
}

function loadJobs(jobs: CronJobHealth[]) {
  return async () => jobs;
}

function payoutWindow(overrides: Partial<PayoutWindowStaleness> = {}): PayoutWindowStaleness {
  return {
    stale: true,
    anchorMonth: "2026-05",
    windowEnd: "2026-05-25",
    runStatus: "partial",
    detail: "Payout window 2026-05 (ended 2026-05-25) is still partial; the automated finalize pass has not been able to publish it.",
    ...overrides,
  };
}

function loadPayoutWindow(staleness: PayoutWindowStaleness | null) {
  return async () => staleness;
}

function deadlineCoverage(overrides: Partial<FeedbackDeadlineCoverage> = {}): FeedbackDeadlineCoverage {
  return {
    stale: true,
    overdueCount: 3,
    oldestDeadlineAt: new Date("2026-06-07T16:59:59.999Z"),
    thresholdHours: 12,
    detail: "3 eligible session(s) passed the feedback deadline more than 12 h ago without a post-deadline assessment (oldest deadline 2026-06-07T16:59:59.999Z); the collector's deadline_crossed lane is not keeping up.",
    ...overrides,
  };
}

function loadDeadlineCoverage(coverage: FeedbackDeadlineCoverage | null) {
  return async () => coverage;
}

// ── sweepCronJobs ─────────────────────────────────────────────────────────

describe("sweepCronJobs", () => {
  it("classifies failing, late, and unknown jobs as unhealthy", () => {
    const jobs = [
      jobHealth({ key: "wise_snapshot", status: "failing" }),
      jobHealth({ key: "leave_requests", status: "late" }),
      jobHealth({ key: "sales_dashboard", status: "unknown" }),
      jobHealth({ key: "credit_control", status: "healthy" }),
      jobHealth({ key: "wise_activity", status: "running" }),
    ];
    const sweep = sweepCronJobs({ jobs, states: [] });

    expect(sweep.checked.map((job) => job.key)).toEqual([
      "wise_snapshot",
      "leave_requests",
      "sales_dashboard",
      "credit_control",
      "wise_activity",
    ]);
    expect(sweep.unhealthy.map((job) => job.key)).toEqual([
      "wise_snapshot",
      "leave_requests",
      "sales_dashboard",
    ]);
    expect(sweep.newAlerts.map((job) => job.key)).toEqual([
      "wise_snapshot",
      "leave_requests",
      "sales_dashboard",
    ]);
    expect(sweep.recoveries).toEqual([]);
  });

  it("never sweeps the watchdog itself or manual-only jobs", () => {
    const jobs = [
      jobHealth({ key: "cron_watchdog", status: "failing" }),
      jobHealth({ key: "room_utilization", status: "manual-only", manualOnly: true }),
    ];
    const sweep = sweepCronJobs({ jobs, states: [] });

    expect(sweep.checked).toEqual([]);
    expect(sweep.unhealthy).toEqual([]);
    expect(sweep.newAlerts).toEqual([]);
  });

  it("keeps an already-alerted job out of newAlerts until it recovers", () => {
    const jobs = [jobHealth({ key: "wise_snapshot", status: "failing" })];
    const sweep = sweepCronJobs({
      jobs,
      states: [alertState({ jobKey: "wise_snapshot" })],
    });

    expect(sweep.unhealthy.map((job) => job.key)).toEqual(["wise_snapshot"]);
    expect(sweep.newAlerts).toEqual([]);
  });

  it("treats a re-failure after recovery as a new episode", () => {
    const jobs = [jobHealth({ key: "wise_snapshot", status: "failing" })];
    const sweep = sweepCronJobs({
      jobs,
      states: [alertState({ jobKey: "wise_snapshot", lastAlertOutcome: "recovered" })],
    });

    expect(sweep.newAlerts.map((job) => job.key)).toEqual(["wise_snapshot"]);
  });

  it("flags recoveries only for previously-alerted jobs that are healthy again", () => {
    const jobs = [
      jobHealth({ key: "wise_snapshot", status: "healthy" }),
      jobHealth({ key: "credit_control", status: "healthy" }),
      jobHealth({ key: "leave_requests", status: "running" }),
    ];
    const sweep = sweepCronJobs({
      jobs,
      states: [
        alertState({ jobKey: "wise_snapshot" }),
        alertState({ jobKey: "leave_requests" }),
      ],
    });

    expect(sweep.recoveries.map((job) => job.key)).toEqual(["wise_snapshot"]);
    expect(sweep.newAlerts).toEqual([]);
  });
});

// ── buildWatchdogEmail ────────────────────────────────────────────────────

describe("buildWatchdogEmail", () => {
  it("renders the unhealthy digest with new-episode markers and the dashboard link", () => {
    const failing = jobHealth({
      key: "wise_snapshot",
      label: "Wise Snapshot",
      status: "failing",
      errorSummary: "HTTP 500",
    });
    const late = jobHealth({
      key: "leave_requests",
      label: "Leave Requests",
      status: "late",
      healthDetail: "No observed run for the latest expected schedule window.",
    });
    const recovered = jobHealth({
      key: "credit_control",
      label: "Credit Control",
      status: "healthy",
    });

    const email = buildWatchdogEmail({
      unhealthy: [failing, late],
      newAlerts: [failing],
      recoveries: [recovered],
    });

    expect(email.subject).toBe("[BGScheduler] 2 cron job(s) unhealthy");
    expect(email.text).toBe(
      [
        "[BGScheduler] 2 cron job(s) unhealthy",
        "",
        "Unhealthy jobs:",
        "- Wise Snapshot [failing, new] - HTTP 500",
        "- Leave Requests [late] - No observed run for the latest expected schedule window.",
        "",
        "Recovered jobs:",
        "- Credit Control recovered",
        "",
        "Open dashboard: https://bgscheduler.vercel.app/data-health",
      ].join("\n"),
    );
    expect(email.html).toContain("<strong>Wise Snapshot</strong> [failing, new] - HTTP 500");
    expect(email.html).toContain("<strong>Credit Control</strong> recovered");
    expect(email.html).toContain("https://bgscheduler.vercel.app/data-health");
  });

  it("uses a recovery subject when nothing is unhealthy and escapes html", () => {
    const recovered = jobHealth({
      key: "wise_snapshot",
      label: "Wise <Snapshot>",
      status: "healthy",
    });
    const email = buildWatchdogEmail({ unhealthy: [], newAlerts: [], recoveries: [recovered] });

    expect(email.subject).toBe("[BGScheduler] 1 cron job(s) recovered");
    expect(email.text).not.toContain("Unhealthy jobs:");
    expect(email.html).toContain("Wise &lt;Snapshot&gt;");
  });
});

// ── runCronWatchdog ───────────────────────────────────────────────────────

describe("runCronWatchdog", () => {
  it("records a newly failing job's episode without emailing anyone", async () => {
    const state = freshState({ alertStates: [settledDigest()] });
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([
        jobHealth({ key: "wise_snapshot", status: "failing", errorSummary: "HTTP 500" }),
        jobHealth({ key: "credit_control", status: "healthy" }),
      ]),
    });

    expect(result).toMatchObject({ checked: 2, unhealthy: 1, alertsSent: 1, recoveries: 0, emailRecipients: 0, digestSent: false });
    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(state.digestUpserts).toEqual([]);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].values).toMatchObject({
      jobKey: "wise_snapshot",
      episodeKey: `wise_snapshot:${NOW.toISOString()}`,
      lastStatus: "failing",
      lastAlertOutcome: "alerted",
      lastAlertedAt: NOW,
      errorSummary: "HTTP 500",
    });
    expect(state.updates).toEqual([]);
  });

  it("does not reopen an episode that is still open", async () => {
    const state = freshState({
      alertStates: [alertState({ jobKey: "wise_snapshot" }), settledDigest()],
    });
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "failing" })]),
    });

    expect(result).toMatchObject({ checked: 1, unhealthy: 1, alertsSent: 0, recoveries: 0 });
    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(state.upserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("alerts for late jobs", async () => {
    const state = freshState();
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "sales_dashboard", status: "late" })]),
    });

    expect(result.alertsSent).toBe(1);
    expect(state.upserts[0].values).toMatchObject({ jobKey: "sales_dashboard", lastStatus: "late" });
  });

  it("alerts for never-ran (unknown) jobs", async () => {
    const state = freshState();
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "progress_tests_digest", status: "unknown" })]),
    });

    expect(result.alertsSent).toBe(1);
    expect(state.upserts[0].values).toMatchObject({
      jobKey: "progress_tests_digest",
      lastStatus: "unknown",
    });
  });

  it("closes a recovered episode without emailing and re-arms the next episode", async () => {
    const state = freshState({
      alertStates: [alertState({ jobKey: "wise_snapshot" }), settledDigest()],
    });
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
    });

    expect(result).toMatchObject({ checked: 1, unhealthy: 0, alertsSent: 0, recoveries: 1 });
    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      lastStatus: "healthy",
      lastAlertOutcome: "recovered",
      lastRecoveredAt: NOW,
    });

    // Second sweep: episode is closed, nothing further goes out.
    const secondState = freshState({
      alertStates: [
        alertState({ jobKey: "wise_snapshot", lastAlertOutcome: "recovered", lastStatus: "healthy" }),
        settledDigest(),
      ],
    });
    const secondSender = makeSender();
    const second = await runCronWatchdog(makeFakeDb(secondState), {
      now: NOW,
      sender: secondSender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
    });

    expect(second).toMatchObject({ alertsSent: 0, recoveries: 0 });
    expect(secondSender.sendEmail).not.toHaveBeenCalled();
    expect(secondState.updates).toEqual([]);
  });

  it("never alerts about the watchdog itself", async () => {
    const state = freshState();
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "cron_watchdog", status: "failing" })]),
    });

    expect(result).toMatchObject({ checked: 0, unhealthy: 0, alertsSent: 0, recoveries: 0 });
    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(state.upserts).toEqual([]);
  });

  it("claims the sweep lock before alerting and releases it afterwards", async () => {
    const state = freshState();
    const sender = makeSender();
    await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "failing" })]),
    });

    expect(state.lockClaims).toHaveLength(1);
    expect(state.lockClaims[0]).toMatchObject({
      jobKey: SWEEP_LOCK_KEY,
      lastStatus: "running",
      lastAlertOutcome: "sweep_lock",
    });
    expect(state.lockReleases).toHaveLength(1);
    expect(state.lockReleases[0]).toMatchObject({ lastStatus: "released" });
    // The sentinel never leaks into episode bookkeeping.
    expect(state.upserts.map((upsert) => upsert.values.jobKey)).toEqual(["wise_snapshot"]);
  });

  it("skips the sweep without emailing when another sweep holds the lock", async () => {
    const state = freshState({ lockAvailable: false });
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "failing" })]),
    });

    expect(result).toMatchObject({ checked: 1, unhealthy: 1, alertsSent: 0, recoveries: 0 });
    expect(result.skippedReason).toBe("another sweep is in flight");
    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(state.upserts).toEqual([]);
    expect(state.lockReleases).toEqual([]);
  });

  it("fails safe without alert spam when cron_alert_state does not exist yet (drizzle-wrapped error)", async () => {
    const state = freshState({ alertStateTableError: drizzleMissingTableError() });
    const sender = makeSender();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runCronWatchdog(makeFakeDb(state), {
        now: NOW,
        sender,
        loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "failing" })]),
      });

      expect(result).toMatchObject({ checked: 1, unhealthy: 1, alertsSent: 0, recoveries: 0 });
      expect(result.skippedReason).toBe("cron_alert_state table unavailable");
      expect(sender.sendEmail).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fails safe on a bare relation-does-not-exist error too", async () => {
    const state = freshState({
      alertStateTableError: new Error('relation "cron_alert_state" does not exist'),
    });
    const sender = makeSender();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runCronWatchdog(makeFakeDb(state), {
        now: NOW,
        sender,
        loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "failing" })]),
      });

      expect(result.skippedReason).toBe("cron_alert_state table unavailable");
      expect(sender.sendEmail).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rethrows unrelated query errors instead of swallowing them", async () => {
    const state = freshState({
      alertStateTableError: new Error("Failed query: select 1\nparams: ", {
        cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
      }),
    });
    const sender = makeSender();
    await expect(
      runCronWatchdog(makeFakeDb(state), {
        now: NOW,
        sender,
        loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "failing" })]),
      }),
    ).rejects.toThrow("Failed query");
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });

  // ── payout window entry ─────────────────────────────────────────────────
  //
  // The accrual cron firing on time proves nothing about whether the window
  // it was meant to close actually published, so the payout window rides the
  // sweep as its own synthetic entry.

  it("alerts on a payout window left un-finalized past its month end", async () => {
    const state = freshState();
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
      loadPayoutWindow: loadPayoutWindow(payoutWindow()),
    });

    expect(result).toMatchObject({ checked: 2, unhealthy: 1, alertsSent: 1, recoveries: 0 });
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].values).toMatchObject({
      jobKey: PAYOUT_WINDOW_JOB_KEY,
      lastStatus: "failing",
      lastAlertOutcome: "alerted",
    });
    const email = vi.mocked(sender.sendEmail).mock.calls[0][0];
    expect(email.text).toContain("Payout Window Finalize [failing, new]");
    expect(email.text).toContain("Payout window 2026-05 (ended 2026-05-25) is still partial");
  });

  it("sends a recovery once the stranded payout window publishes", async () => {
    const state = freshState({
      alertStates: [alertState({ jobKey: PAYOUT_WINDOW_JOB_KEY })],
    });
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
      loadPayoutWindow: loadPayoutWindow(payoutWindow({
        stale: false,
        runStatus: null,
        detail: "Payout window 2026-05 is finalized.",
      })),
    });

    expect(result).toMatchObject({ checked: 2, unhealthy: 0, alertsSent: 0, recoveries: 1 });
    expect(state.updates[0]).toMatchObject({
      lastStatus: "healthy",
      lastAlertOutcome: "recovered",
    });
  });

  it("adds no payout entry when the staleness loader yields nothing", async () => {
    const state = freshState();
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
      loadPayoutWindow: loadPayoutWindow(null),
    });

    expect(result).toMatchObject({ checked: 1, unhealthy: 0, alertsSent: 0 });
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });

  it("still sweeps every cron job when the payout window check throws", async () => {
    const state = freshState();
    const sender = makeSender();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runCronWatchdog(makeFakeDb(state), {
        now: NOW,
        sender,
        loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "failing" })]),
        loadPayoutWindow: async () => {
          throw new Error('relation "post_class_payout_runs" does not exist');
        },
      });

      expect(result).toMatchObject({ checked: 1, unhealthy: 1, alertsSent: 1 });
      expect(state.upserts[0].values).toMatchObject({ jobKey: "wise_snapshot" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  // ── feedback deadline coverage entry (FU1) ──────────────────────────────
  //
  // The collection cron firing on time proves nothing about whether classes
  // that crossed their feedback deadline were ever re-observed afterwards,
  // which is what charging a late or short submission depends on.

  it("alerts when eligible sessions sit unassessed more than 12 h past their feedback deadline", async () => {
    const state = freshState();
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
      loadPayoutWindow: loadPayoutWindow(null),
      loadDeadlineCoverage: loadDeadlineCoverage(deadlineCoverage()),
    });

    expect(result).toMatchObject({ checked: 2, unhealthy: 1, alertsSent: 1, recoveries: 0 });
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].values).toMatchObject({
      jobKey: DEADLINE_COVERAGE_JOB_KEY,
      lastStatus: "failing",
      lastAlertOutcome: "alerted",
    });
    const email = vi.mocked(sender.sendEmail).mock.calls[0][0];
    expect(email.text).toContain("Feedback Deadline Coverage [failing, new]");
    expect(email.text).toContain(deadlineCoverage().detail);
  });

  it("sends a recovery once the deadline backlog drains", async () => {
    const state = freshState({
      alertStates: [alertState({ jobKey: DEADLINE_COVERAGE_JOB_KEY })],
    });
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
      loadPayoutWindow: loadPayoutWindow(null),
      loadDeadlineCoverage: loadDeadlineCoverage(deadlineCoverage({
        stale: false,
        overdueCount: 0,
        oldestDeadlineAt: null,
        detail: "No eligible session in the charging scope is more than 12 h past its feedback deadline without a post-deadline assessment.",
      })),
    });

    expect(result).toMatchObject({ checked: 2, unhealthy: 0, alertsSent: 0, recoveries: 1 });
    expect(state.updates[0]).toMatchObject({
      lastStatus: "healthy",
      lastAlertOutcome: "recovered",
    });
  });

  it("adds no deadline coverage entry when the loader yields nothing", async () => {
    const state = freshState();
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
      loadPayoutWindow: loadPayoutWindow(null),
      loadDeadlineCoverage: loadDeadlineCoverage(null),
    });

    expect(result).toMatchObject({ checked: 1, unhealthy: 0, alertsSent: 0 });
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });

  it("still sweeps every cron job when the deadline coverage check throws", async () => {
    const state = freshState();
    const sender = makeSender();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runCronWatchdog(makeFakeDb(state), {
        now: NOW,
        sender,
        loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "failing" })]),
        loadPayoutWindow: loadPayoutWindow(null),
        loadDeadlineCoverage: async () => {
          throw new Error("Feedback deadline coverage query returned no aggregate row.");
        },
      });

      expect(result).toMatchObject({ checked: 1, unhealthy: 1, alertsSent: 1 });
      expect(state.upserts[0].values).toMatchObject({ jobKey: "wise_snapshot" });
      expect(errorSpy).toHaveBeenCalledWith(
        "Cron watchdog could not evaluate feedback deadline coverage",
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
  // cron_invocations is append-only and nothing pruned it. Retention rides
  // the watchdog, but it is bookkeeping: a failed prune must never suppress
  // an alert digest.
  it("reports the cron_invocations rows the retention sweep removed", async () => {
    const state = freshState();
    const sender = makeSender();
    const pruneInvocations = vi.fn(async () => 512);

    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
      loadPayoutWindow: loadPayoutWindow(null),
      pruneInvocations,
    });

    expect(pruneInvocations).toHaveBeenCalledWith(expect.anything(), NOW);
    expect(result.invocationsPruned).toBe(512);
  });

  it("still alerts when the retention sweep throws", async () => {
    const state = freshState();
    const sender = makeSender();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runCronWatchdog(makeFakeDb(state), {
        now: NOW,
        sender,
        loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "failing" })]),
        loadPayoutWindow: loadPayoutWindow(null),
        pruneInvocations: async () => {
          throw new Error('relation "cron_invocations" does not exist');
        },
      });

      expect(result).toMatchObject({ checked: 1, unhealthy: 1, alertsSent: 1, invocationsPruned: 0 });
    } finally {
      errorSpy.mockRestore();
    }
  });
});


describe("private weekend watchdog routing", () => {
  it("excludes weekend details from shared mail, even when another job is failing", async () => {
    vi.stubEnv("CLASSROOM_WEEKEND_ALERT_EMAIL", "kevhsh7@gmail.com");
    try {
      const state = freshState();
      const sender = makeSender();
      await runCronWatchdog(makeFakeDb(state), { now: NOW, sender, recipients: ["a@x.com"], loadPayoutWindow: loadPayoutWindow(null),
        loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", label: "Wise Snapshot", status: "failing" }),
          jobHealth({ key: "classroom_weekend_check", label: "Weekend Classroom Check", status: "failing", errorSummary: "PRIVATE-WEEKEND-DETAIL" })]) });
      const messages = vi.mocked(sender.sendEmail).mock.calls.map(call => call[0]);
      expect(messages.filter(message => message.to !== "kevhsh7@gmail.com")).toHaveLength(1);
      for (const message of messages.filter(message => message.to !== "kevhsh7@gmail.com")) {
        expect(message.text).not.toContain("PRIVATE-WEEKEND-DETAIL");
        expect(message.text).not.toContain("Weekend Classroom");
      }
      expect(messages.find(message => message.to === "kevhsh7@gmail.com")?.text).toContain("PRIVATE-WEEKEND-DETAIL");
    } finally { vi.unstubAllEnvs(); }
  });
  it("never falls back to admin recipients for a missing private address", async () => {
    vi.stubEnv("CLASSROOM_WEEKEND_ALERT_EMAIL", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sender = makeSender();
      await runCronWatchdog(makeFakeDb(freshState()), { now: NOW, sender, loadPayoutWindow: loadPayoutWindow(null),
        loadJobs: loadJobs([jobHealth({ key: "classroom_weekend_check", status: "failing" })]) });
      expect(sender.sendEmail).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); error.mockRestore(); }
  });
});

// ── daily digest (WD-DIGEST-01) ─────────────────────────────────────────

describe("daily digest", () => {
  const failing = () => jobHealth({ key: "wise_snapshot", label: "Wise Snapshot", status: "failing", errorSummary: "HTTP 500" });

  it("sends nothing before 08:00 Bangkok", async () => {
    const state = freshState();
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: BEFORE_DIGEST_HOUR, sender, recipients: ["kevin@x.com"], loadJobs: loadJobs([failing()]),
    });

    expect(result).toMatchObject({ alertsSent: 1, emailRecipients: 0, digestSent: false });
    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(state.digestUpserts).toEqual([]);
  });

  it("emails one digest to the configured recipients only, never admin_users", async () => {
    const state = freshState({ adminEmails: ["a@x.com", "b@x.com"] });
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW, sender, recipients: ["kevin@x.com"], loadJobs: loadJobs([failing()]),
    });

    expect(result).toMatchObject({ unhealthy: 1, alertsSent: 1, emailRecipients: 1, digestSent: true });
    expect(sender.sendEmail).toHaveBeenCalledTimes(1);
    const email = vi.mocked(sender.sendEmail).mock.calls[0][0];
    expect(email.to).toBe("kevin@x.com");
    expect(email.subject).toBe("[BGScheduler] Daily cron digest 2026-06-10: 1 cron job(s) unhealthy");
    expect(email.idempotencyKey).toBe("cron-watchdog-digest:2026-06-10:kevin@x.com");
    expect(email.text).toContain("Wise Snapshot [failing, new] - HTTP 500");
    expect(state.digestUpserts).toEqual([
      expect.objectContaining({ jobKey: DAILY_DIGEST_KEY, episodeKey: "digest:2026-06-10", lastAlertOutcome: "digest_sent" }),
    ]);
  });

  it("does not send a second digest the same Bangkok day", async () => {
    const state = freshState({ alertStates: [alertState({ jobKey: "wise_snapshot" }), settledDigest()] });
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: new Date("2026-06-10T11:37:00.000Z"), sender, recipients: ["kevin@x.com"], loadJobs: loadJobs([failing()]),
    });

    expect(result.digestSent).toBe(false);
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });

  it("sends the next day's digest even while the same episode stays open", async () => {
    const state = freshState({ alertStates: [alertState({ jobKey: "wise_snapshot" }), settledDigest("2026-06-09")] });
    const sender = makeSender();
    await runCronWatchdog(makeFakeDb(state), {
      now: NOW, sender, recipients: ["kevin@x.com"], loadJobs: loadJobs([failing()]),
    });

    expect(sender.sendEmail).toHaveBeenCalledTimes(1);
    // Opened at 02:37 UTC today, within the 24 h window, so still marked new.
    expect(vi.mocked(sender.sendEmail).mock.calls[0][0].text).toContain("[failing, new]");
  });

  it("lists recoveries from the last 24 hours", async () => {
    const state = freshState({
      alertStates: [alertState({
        jobKey: "wise_snapshot",
        lastAlertOutcome: "recovered",
        lastStatus: "healthy",
        lastRecoveredAt: new Date("2026-06-09T20:00:00.000Z"),
      })],
    });
    const sender = makeSender();
    await runCronWatchdog(makeFakeDb(state), {
      now: NOW, sender, recipients: ["kevin@x.com"],
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", label: "Wise Snapshot", status: "healthy" })]),
    });

    const email = vi.mocked(sender.sendEmail).mock.calls[0][0];
    expect(email.subject).toBe("[BGScheduler] Daily cron digest 2026-06-10: 1 cron job(s) recovered");
    expect(email.text).toContain("Wise Snapshot recovered");
  });

  it("reaches back to the previous digest when today's goes out late", async () => {
    const lateNow = new Date("2026-06-10T09:07:00.000Z"); // 16:07 Bangkok
    const state = freshState({
      alertStates: [
        alertState({ jobKey: DAILY_DIGEST_KEY, episodeKey: "digest:2026-06-09", lastAlertOutcome: "digest_sent",
          lastAlertedAt: new Date("2026-06-09T01:07:00.000Z") }),
        // Closed 30 h before lateNow: outside a plain 24 h window, after the last digest.
        alertState({ jobKey: "wise_snapshot", lastAlertOutcome: "recovered", lastStatus: "healthy",
          lastAlertedAt: new Date("2026-06-09T02:00:00.000Z"), lastRecoveredAt: new Date("2026-06-09T03:07:00.000Z") }),
      ],
    });
    const sender = makeSender();
    await runCronWatchdog(makeFakeDb(state), {
      now: lateNow, sender, recipients: ["kevin@x.com"],
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", label: "Wise Snapshot", status: "healthy" })]),
    });

    expect(vi.mocked(sender.sendEmail).mock.calls[0][0].text).toContain("Wise Snapshot recovered");
  });

  it("keeps the last settled send time when an attempt is rejected", async () => {
    const previous = new Date("2026-06-09T01:07:00.000Z");
    const state = freshState({ alertStates: [alertState({ jobKey: DAILY_DIGEST_KEY, episodeKey: "digest:2026-06-09",
      lastAlertOutcome: "digest_sent", lastAlertedAt: previous })] });
    const sender = makeSender(async () => { throw new ScheduleEmailRejection("quota"); });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runCronWatchdog(makeFakeDb(state), { now: NOW, sender, recipients: ["kevin@x.com"], loadJobs: loadJobs([failing()]) });
    } finally {
      errorSpy.mockRestore();
    }
    expect(state.digestUpserts[0]).toMatchObject({ lastAlertOutcome: "digest_failed", lastAlertedAt: previous });
  });

  it("settles a quiet day without sending", async () => {
    const state = freshState();
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW, sender, recipients: ["kevin@x.com"],
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
    });

    expect(result.digestSent).toBe(false);
    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(state.digestUpserts).toEqual([
      expect.objectContaining({ episodeKey: "digest:2026-06-10", lastAlertOutcome: "digest_empty" }),
    ]);
  });

  it("leaves the day unsettled after a pre-acceptance rejection so the next sweep retries", async () => {
    const state = freshState();
    const sender = makeSender(async () => {
      throw new ScheduleEmailRejection("MailApp daily recipient quota is exhausted");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runCronWatchdog(makeFakeDb(state), {
        now: NOW, sender, recipients: ["kevin@x.com"], loadJobs: loadJobs([failing()]),
      });

      expect(result).toMatchObject({ digestSent: false, skippedReason: "email delivery failed" });
      expect(state.digestUpserts).toEqual([
        expect.objectContaining({ episodeKey: "digest-failed:2026-06-10", lastAlertOutcome: "digest_failed" }),
      ]);
      // Episode bookkeeping does not depend on delivery.
      expect(state.upserts[0].values).toMatchObject({ jobKey: "wise_snapshot", lastAlertOutcome: "alerted" });
    } finally {
      errorSpy.mockRestore();
    }

    const retrySender = makeSender();
    const retryState = freshState({ alertStates: [
      alertState({ jobKey: "wise_snapshot" }),
      alertState({ jobKey: DAILY_DIGEST_KEY, episodeKey: "digest-failed:2026-06-10", lastAlertOutcome: "digest_failed" }),
    ] });
    const retry = await runCronWatchdog(makeFakeDb(retryState), {
      now: new Date("2026-06-10T03:37:00.000Z"), sender: retrySender, recipients: ["kevin@x.com"], loadJobs: loadJobs([failing()]),
    });
    expect(retry.digestSent).toBe(true);
    expect(retrySender.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("never resends after an uncertain delivery outcome", async () => {
    const state = freshState();
    const sender = makeSender(async () => {
      throw new Error("Email acceptance could not be confirmed. Reconcile before resending.");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runCronWatchdog(makeFakeDb(state), {
        now: NOW, sender, recipients: ["kevin@x.com"], loadJobs: loadJobs([failing()]),
      });
      expect(result).toMatchObject({ digestSent: false, emailRecipients: 0, skippedReason: "digest outcome uncertain" });
      expect(state.digestUpserts).toEqual([
        expect.objectContaining({ episodeKey: "digest:2026-06-10", lastAlertOutcome: "digest_sent" }),
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("watchdogAlertRecipients", () => {
  it("defaults to Kevin", () => {
    expect(watchdogAlertRecipients({})).toEqual(["kevhsh7@gmail.com"]);
    expect(watchdogAlertRecipients({ CRON_WATCHDOG_ALERT_EMAILS: "  " })).toEqual(["kevhsh7@gmail.com"]);
  });

  it("parses, lowercases, and de-duplicates a list", () => {
    expect(watchdogAlertRecipients({ CRON_WATCHDOG_ALERT_EMAILS: "A@x.com, b@x.com;a@x.com" })).toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("bangkokClock", () => {
  it("rolls the date at Bangkok midnight", () => {
    expect(bangkokClock(new Date("2026-06-09T16:59:00.000Z"))).toEqual({ date: "2026-06-09", hour: 23 });
    expect(bangkokClock(new Date("2026-06-09T17:00:00.000Z"))).toEqual({ date: "2026-06-10", hour: 0 });
  });
});
