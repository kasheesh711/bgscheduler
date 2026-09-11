import { afterEach, describe, expect, it, vi } from "vitest";
import { getCronJobDefinition } from "../cron-registry";
import { evaluateCronJobStatus, type RunEvidence } from "../status";

function job(key: string) {
  const value = getCronJobDefinition(key);
  if (!value) throw new Error(`Missing job ${key}`);
  return value;
}

function run(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return {
    status: overrides.status ?? "success",
    startedAt: overrides.startedAt ?? new Date("2026-06-01T01:00:00.000Z"),
    finishedAt: overrides.finishedAt ?? new Date("2026-06-01T01:04:00.000Z"),
    errorSummary: overrides.errorSummary ?? null,
  };
}

describe("cron status evaluation", () => {
  it("uses inferred run evidence before audit rows accumulate", () => {
    const latest = run();
    const result = evaluateCronJobStatus({
      job: job("wise_snapshot"),
      now: new Date("2026-06-01T01:20:00.000Z"),
      latestInvocation: null,
      latestCronInvocation: null,
      latestRun: latest,
      latestSuccessfulRun: latest,
      latestFailedRun: null,
      runningRun: null,
    });

    expect(result.status).toBe("healthy");
    expect(result.proof).toBe("inferred");
    expect(result.healthDetail).toContain("run-table");
  });

  it("marks interval crons late after the expected window is missed", () => {
    const latest = run({
      startedAt: new Date("2026-06-01T00:00:00.000Z"),
      finishedAt: new Date("2026-06-01T00:04:00.000Z"),
    });
    const result = evaluateCronJobStatus({
      job: job("wise_snapshot"),
      now: new Date("2026-06-01T02:50:00.000Z"),
      latestInvocation: null,
      latestCronInvocation: null,
      latestRun: latest,
      latestSuccessfulRun: latest,
      latestFailedRun: null,
      runningRun: null,
    });

    expect(result.status).toBe("late");
  });

  it("evaluates daily Bangkok windows without rolling 24-hour shortcuts", () => {
    const latest = run({
      startedAt: new Date("2026-05-31T10:00:00.000Z"),
      finishedAt: new Date("2026-05-31T10:10:00.000Z"),
    });
    const result = evaluateCronJobStatus({
      job: job("classroom_morning"),
      now: new Date("2026-06-01T00:20:00.000Z"),
      latestInvocation: null,
      latestCronInvocation: null,
      latestRun: latest,
      latestSuccessfulRun: latest,
      latestFailedRun: null,
      runningRun: null,
    });

    expect(result.status).toBe("healthy");
    expect(result.lastExpectedAt?.toISOString()).toBe("2026-05-31T10:00:00.000Z");
  });

  it("evaluates the weekly competitor intelligence Monday Bangkok window", () => {
    const latest = run({
      startedAt: new Date("2026-06-14T18:28:00.000Z"),
      finishedAt: new Date("2026-06-14T18:36:00.000Z"),
    });
    const result = evaluateCronJobStatus({
      job: job("competitor_intelligence"),
      now: new Date("2026-06-14T19:00:00.000Z"),
      latestInvocation: null,
      latestCronInvocation: null,
      latestRun: latest,
      latestSuccessfulRun: latest,
      latestFailedRun: null,
      runningRun: null,
    });

    expect(result.status).toBe("healthy");
    expect(result.lastExpectedAt?.toISOString()).toBe("2026-06-14T18:28:00.000Z");
    expect(result.nextExpectedAt?.toISOString()).toBe("2026-06-21T18:28:00.000Z");
  });

  it("marks the weekly competitor intelligence cron late after the Monday window is missed", () => {
    const latest = run({
      startedAt: new Date("2026-06-07T18:28:00.000Z"),
      finishedAt: new Date("2026-06-07T18:36:00.000Z"),
    });
    const result = evaluateCronJobStatus({
      job: job("competitor_intelligence"),
      now: new Date("2026-06-14T21:00:00.000Z"),
      latestInvocation: null,
      latestCronInvocation: null,
      latestRun: latest,
      latestSuccessfulRun: latest,
      latestFailedRun: null,
      runningRun: null,
    });

    expect(result.status).toBe("late");
    expect(result.lastExpectedAt?.toISOString()).toBe("2026-06-14T18:28:00.000Z");
    expect(result.lateAfterAt?.toISOString()).toBe("2026-06-14T20:28:00.000Z");
  });

  // credit_control declares maxDuration 800 (mirroring its route), so a run
  // is only stuck past 800s + the 60s buffer. A 300s registry value used to
  // report healthy 372-390s production runs as failing.
  it("marks long-running jobs as failing after maxDuration plus buffer", () => {
    const running = run({
      status: "running",
      startedAt: new Date("2026-06-01T01:00:00.000Z"),
      finishedAt: null,
    });
    const evaluateAt = (now: string) => evaluateCronJobStatus({
      job: job("credit_control"),
      now: new Date(now),
      latestInvocation: null,
      latestCronInvocation: null,
      latestRun: running,
      latestSuccessfulRun: null,
      latestFailedRun: null,
      runningRun: running,
    });

    expect(evaluateAt("2026-06-01T01:07:00.000Z").status).toBe("running");
    expect(evaluateAt("2026-06-01T01:13:00.000Z").status).toBe("running");

    const stuck = evaluateAt("2026-06-01T01:15:00.000Z");
    expect(stuck.status).toBe("failing");
    expect(stuck.healthDetail).toContain("maxDuration");
  });

  it("recovers from an older failure after a later success", () => {
    const success = run({
      startedAt: new Date("2026-06-01T01:00:00.000Z"),
      finishedAt: new Date("2026-06-01T01:03:00.000Z"),
    });
    const failure = run({
      status: "failed",
      startedAt: new Date("2026-06-01T00:30:00.000Z"),
      finishedAt: new Date("2026-06-01T00:31:00.000Z"),
      errorSummary: "Earlier failure",
    });
    const result = evaluateCronJobStatus({
      job: job("wise_snapshot"),
      now: new Date("2026-06-01T01:20:00.000Z"),
      latestInvocation: null,
      latestCronInvocation: null,
      latestRun: success,
      latestSuccessfulRun: success,
      latestFailedRun: failure,
      runningRun: null,
    });

    expect(result.status).toBe("healthy");
  });
});


describe("retired shared-data health", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("does not let skipped heartbeat ticks hide an old snapshot", () => {
    vi.stubEnv("CREDIT_CONTROL_MODE", "retired");
    const previous = run({ startedAt: new Date("2026-09-09T23:20:00Z"), finishedAt: new Date("2026-09-09T23:25:00Z") });
    const now = new Date("2026-09-11T03:00:00Z");
    const result = evaluateCronJobStatus({ job: job("credit_control"), now,
      latestInvocation: null, latestCronInvocation: { receivedAt: now, finishedAt: now, outcome: "skipped", responseStatus: 200, durationMs: 1, errorSummary: null },
      latestRun: previous, latestSuccessfulRun: previous, latestFailedRun: null, runningRun: null });
    expect(result.status).toBe("late");
    expect(result.lastSuccessAt).toEqual(previous.finishedAt);
  });
  it("reports paused alerts without stale or failure alarms", () => {
    vi.stubEnv("CREDIT_CONTROL_MODE", "retired");
    const result = evaluateCronJobStatus({ job: job("line_credit_digest"), now: new Date(),
      latestInvocation: null, latestCronInvocation: null, latestRun: run({ status: "failed" }), latestSuccessfulRun: null,
      latestFailedRun: run({ status: "failed" }), runningRun: null });
    expect(result.status).toBe("paused"); expect(result.nextExpectedAt).toBeNull();
  });
});
