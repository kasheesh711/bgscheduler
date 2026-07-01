import { describe, expect, it } from "vitest";
import { getCronJobDefinition } from "../cron-registry";
import { evaluateCronJobStatus, type InvocationEvidence, type RunEvidence } from "../status";

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

function invocation(overrides: Partial<InvocationEvidence> = {}): InvocationEvidence {
  return {
    outcome: overrides.outcome ?? "success",
    receivedAt: overrides.receivedAt ?? new Date("2026-06-30T17:05:00.000Z"),
    finishedAt: overrides.finishedAt ?? new Date("2026-06-30T17:06:00.000Z"),
    durationMs: overrides.durationMs ?? 60_000,
    responseStatus: overrides.responseStatus ?? 200,
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
      startedAt: new Date("2026-05-31T23:45:00.000Z"),
      finishedAt: new Date("2026-05-31T23:55:00.000Z"),
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
    expect(result.lastExpectedAt?.toISOString()).toBe("2026-05-31T23:45:00.000Z");
  });

  it("evaluates the weekly competitor intelligence Monday Bangkok window", () => {
    const latest = run({
      startedAt: new Date("2026-06-14T18:25:00.000Z"),
      finishedAt: new Date("2026-06-14T18:33:00.000Z"),
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
    expect(result.lastExpectedAt?.toISOString()).toBe("2026-06-14T18:25:00.000Z");
    expect(result.nextExpectedAt?.toISOString()).toBe("2026-06-21T18:25:00.000Z");
  });

  it("marks the weekly competitor intelligence cron late after the Monday window is missed", () => {
    const latest = run({
      startedAt: new Date("2026-06-07T18:25:00.000Z"),
      finishedAt: new Date("2026-06-07T18:33:00.000Z"),
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
    expect(result.lastExpectedAt?.toISOString()).toBe("2026-06-14T18:25:00.000Z");
    expect(result.lateAfterAt?.toISOString()).toBe("2026-06-14T20:25:00.000Z");
  });

  it("marks long-running jobs as failing after maxDuration plus buffer", () => {
    const running = run({
      status: "running",
      startedAt: new Date("2026-06-01T01:00:00.000Z"),
      finishedAt: null,
    });
    const result = evaluateCronJobStatus({
      job: job("credit_control"),
      now: new Date("2026-06-01T01:07:00.000Z"),
      latestInvocation: null,
      latestCronInvocation: null,
      latestRun: running,
      latestSuccessfulRun: null,
      latestFailedRun: null,
      runningRun: running,
    });

    expect(result.status).toBe("failing");
    expect(result.healthDetail).toContain("maxDuration");
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

  it("evaluates Student Promotions as one one-shot Bangkok window before target time", () => {
    const result = evaluateCronJobStatus({
      job: job("student_promotions_july_1"),
      now: new Date("2026-06-30T16:59:00.000Z"),
      latestInvocation: null,
      latestCronInvocation: null,
      latestRun: null,
      latestSuccessfulRun: null,
      latestFailedRun: null,
      runningRun: null,
    });

    expect(result.status).toBe("unknown");
    expect(result.lastExpectedAt).toBeNull();
    expect(result.nextExpectedAt?.toISOString()).toBe("2026-06-30T17:05:00.000Z");
    expect(result.lateAfterAt).toBeNull();
  });

  it("keeps Student Promotions on the July 1 one-shot window after target time", () => {
    const result = evaluateCronJobStatus({
      job: job("student_promotions_july_1"),
      now: new Date("2026-07-01T18:00:00.000Z"),
      latestInvocation: null,
      latestCronInvocation: null,
      latestRun: null,
      latestSuccessfulRun: null,
      latestFailedRun: null,
      runningRun: null,
    });

    expect(result.status).toBe("unknown");
    expect(result.lastExpectedAt?.toISOString()).toBe("2026-06-30T17:05:00.000Z");
    expect(result.nextExpectedAt).toBeNull();
    expect(result.lateAfterAt?.toISOString()).toBe("2026-07-01T17:05:00.000Z");
  });

  it("does not mark Student Promotions late on later days after the one-shot succeeded", () => {
    const direct = invocation();
    const result = evaluateCronJobStatus({
      job: job("student_promotions_july_1"),
      now: new Date("2026-07-03T00:00:00.000Z"),
      latestInvocation: direct,
      latestCronInvocation: direct,
      latestRun: null,
      latestSuccessfulRun: null,
      latestFailedRun: null,
      runningRun: null,
    });

    expect(result.status).toBe("healthy");
    expect(result.proof).toBe("direct");
    expect(result.lastExpectedAt?.toISOString()).toBe("2026-06-30T17:05:00.000Z");
    expect(result.nextExpectedAt).toBeNull();
  });
});
