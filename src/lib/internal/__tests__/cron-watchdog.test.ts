import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import type { CronJobHealth } from "@/lib/data-health/types";
import {
  buildWatchdogEmail,
  runCronWatchdog,
  sweepCronJobs,
  type CronAlertStateRow,
} from "@/lib/internal/cron-watchdog";

// ── Fixtures ──────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-10T03:07:00.000Z");

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

// ── Fake db ───────────────────────────────────────────────────────────────
//
// cron-watchdog.ts uses the Drizzle fluent builder directly, so the tests
// stand up a small chainable fake. Reads are routed by table reference;
// writes are recorded so the episode bookkeeping can be asserted.

interface FakeDbState {
  adminEmails: string[];
  alertStates: CronAlertStateRow[];
  alertStateTableError: Error | null;
  upserts: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }>;
  updates: Array<Record<string, unknown>>;
}

function freshState(overrides: Partial<FakeDbState> = {}): FakeDbState {
  return {
    adminEmails: ["a@x.com", "b@x.com"],
    alertStates: [],
    alertStateTableError: null,
    upserts: [],
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
              if (table === schema.cronAlertState) {
                state.upserts.push({ values, set: config.set });
              }
              return Promise.resolve([]);
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
                state.updates.push(values);
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
  it("alerts once for a newly failing job and records the episode", async () => {
    const state = freshState();
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([
        jobHealth({ key: "wise_snapshot", status: "failing", errorSummary: "HTTP 500" }),
        jobHealth({ key: "credit_control", status: "healthy" }),
      ]),
    });

    expect(result).toMatchObject({ checked: 2, unhealthy: 1, alertsSent: 1, recoveries: 0 });
    expect(sender.sendEmail).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(sender.sendEmail).mock.calls[0][0];
    expect(firstCall.to).toBe("a@x.com");
    expect(firstCall.subject).toBe("[BGScheduler] 1 cron job(s) unhealthy");
    expect(firstCall.idempotencyKey).toBe(`cron-watchdog:${NOW.toISOString()}:a@x.com`);
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

  it("does not send a duplicate alert while the episode is still open", async () => {
    const state = freshState({
      alertStates: [alertState({ jobKey: "wise_snapshot" })],
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

  it("sends a recovery notice once and re-arms the next episode", async () => {
    const state = freshState({
      alertStates: [alertState({ jobKey: "wise_snapshot" })],
    });
    const sender = makeSender();
    const result = await runCronWatchdog(makeFakeDb(state), {
      now: NOW,
      sender,
      loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "healthy" })]),
    });

    expect(result).toMatchObject({ checked: 1, unhealthy: 0, alertsSent: 0, recoveries: 1 });
    expect(sender.sendEmail).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sender.sendEmail).mock.calls[0][0].subject).toBe(
      "[BGScheduler] 1 cron job(s) recovered",
    );
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

  it("leaves the episode unmarked when no recipient can be reached, so the next sweep retries", async () => {
    const state = freshState();
    const sender = makeSender(async () => {
      throw new Error("Apps Script email send failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runCronWatchdog(makeFakeDb(state), {
        now: NOW,
        sender,
        loadJobs: loadJobs([jobHealth({ key: "wise_snapshot", status: "failing" })]),
      });

      expect(result).toMatchObject({ unhealthy: 1, alertsSent: 0, recoveries: 0 });
      expect(result.skippedReason).toBe("email delivery failed");
      expect(state.upserts).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
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
});
