import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCronJobDefinition } from "../cron-registry";
import { evaluateCronJobStatus, expectedWindowForJob } from "../status";
const job = getCronJobDefinition("classroom_weekend_check")!;
beforeEach(() => vi.stubEnv("CLASSROOM_WEEKEND_ALERTS_ENABLED_AT", "2026-09-07T05:00:00Z"));
afterEach(() => vi.unstubAllEnvs());
function status(now: string, last?: string) {
  const run = last ? { status: "success", startedAt: new Date(last), finishedAt: new Date(last), errorSummary: null } : null;
  return evaluateCronJobStatus({ job, now: new Date(now), latestInvocation: null, latestCronInvocation: null,
    latestRun: run, latestSuccessfulRun: run, latestFailedRun: null, runningRun: null });
}
describe("Wednesday–Friday calendar expectations", () => {
  it("does not invent missed checks before the first activated window", () => {
    for (const now of ["2026-09-07T06:00:00Z", "2026-09-08T06:00:00Z", "2026-09-09T01:59:00Z", "2026-09-09T02:30:00Z"]) {
      expect(status(now).status).toBe("healthy");
    }
    expect(status("2026-09-09T03:00:00Z").status).toBe("unknown");
  });
  it("expects Thursday and Friday independently", () => {
    expect(status("2026-09-10T03:00:00Z", "2026-09-09T02:05:00Z").status).toBe("late");
    expect(status("2026-09-11T03:00:00Z", "2026-09-10T02:05:00Z").status).toBe("late");
  });
  it("carries Friday's proof across the four unscheduled days", () => {
    for (const day of [12, 13, 14, 15]) expect(status(`2026-09-${day}T03:00:00Z`, "2026-09-11T02:05:00Z").status).toBe("healthy");
    expect(status("2026-09-16T03:00:00Z", "2026-09-11T02:05:00Z").status).toBe("late");
  });
  it("sets the next check to Wednesday after Friday", () => {
    expect(expectedWindowForJob(job, new Date("2026-09-11T03:00:00Z")).nextExpectedAt?.toISOString()).toBe("2026-09-16T02:00:00.000Z");
  });
  it("keeps unactivated checks visibly disabled", () => {
    vi.stubEnv("CLASSROOM_WEEKEND_ALERTS_ENABLED_AT", "");
    expect(status("2026-09-09T03:00:00Z").status).toBe("manual-only");
  });
});
