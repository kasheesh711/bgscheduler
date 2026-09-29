import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_JOBS, SCHEDULED_CRON_JOBS, getCronJobDefinition, isManuallyRunnable, manuallyRunnableCronJobs, type CronJobDefinition } from "../cron-registry";

interface MaxDurationMismatch {
  path: string;
  /** null when the route declares no `maxDuration` at all. */
  route: number | null;
  registry: number;
}

/** Absolute path of the route handler a registry entry's `path` points at. */
function routeFilePath(registryPath: string): string {
  return path.join(process.cwd(), "src", "app", "api", ...registryPath.replace(/^\/api\//, "").split("/"), "route.ts");
}

describe("data-health cron registry", () => {
  it("matches the deployed vercel cron registry", () => {
    const vercel = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };

    const expected = SCHEDULED_CRON_JOBS
      .map((job) => ({ path: job.path, schedule: job.schedule }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const actual = vercel.crons
      .map((job) => ({ path: job.path, schedule: job.schedule }))
      .sort((a, b) => a.path.localeCompare(b.path));

    expect(expected).toEqual(actual);
  });

  it("registers the admissions notifications cron as a scheduled daily job", () => {
    const job = SCHEDULED_CRON_JOBS.find(
      (candidate) => candidate.path === "/api/internal/admissions-notifications",
    );

    expect(job).toBeDefined();
    expect(job?.key).toBe("admissions_notifications");
    expect(job?.schedule).toBe("12 1 * * *");
    expect(job?.routeMethod).toBe("GET");
  });

  it("declares the room utilization sync as manual-only", () => {
    const paths = SCHEDULED_CRON_JOBS.map((job) => job.path as string);
    expect(paths).not.toContain("/api/internal/sync-room-utilization");
  });

  it("points every registry entry at a real route handler", () => {
    const missing = CRON_JOBS
      .filter((job) => !existsSync(routeFilePath(job.path)))
      .map((job) => job.path as string);

    expect(missing).toEqual([]);
  });

  // The registry's maxDurationSeconds drives stuck-run detection
  // (status.ts: runningStuckAt = receivedAt + maxDurationSeconds + buffer), so
  // a value below the route's own `maxDuration` reports a legitimate long run
  // as `failing`. Read as text: importing a route pulls in the Next/auth graph.
  it("mirrors each route's exported maxDuration", () => {
    const mismatches = CRON_JOBS.flatMap((job): MaxDurationMismatch[] => {
      const source = readFileSync(routeFilePath(job.path), "utf8");
      const declared = /export const maxDuration = (\d+)/.exec(source);
      const route = declared ? Number(declared[1]) : null;
      return route === (job.maxDurationSeconds as number)
        ? []
        : [{ path: job.path, route, registry: job.maxDurationSeconds }];
    });

    expect(mismatches).toEqual([]);
  });

  it("excludes only the annual student promotions job from Data Health one-click runs", () => {
    const registry: readonly CronJobDefinition[] = CRON_JOBS;
    const excluded = registry.filter((job) => job.manualRunDisabledReason !== undefined);

    expect(excluded.map((job) => job.key)).toEqual(["student_promotions_july_1"]);
    // The reason is the refusal message a caller sees, so it must say something.
    expect(excluded.every((job) => (job.manualRunDisabledReason ?? "").trim().length > 0)).toBe(true);
  });

  it("offers a manual run only for live, dispatchable jobs", () => {
    const job = getCronJobDefinition("cron_watchdog")!;

    expect(isManuallyRunnable(job)).toBe(true);
    expect(isManuallyRunnable({ ...job, paused: true })).toBe(false);
    expect(isManuallyRunnable({ ...job, manualRunDisabledReason: "Owner-only workflow." })).toBe(false);
    expect(isManuallyRunnable({ ...job, manualRunDisabledReason: "" })).toBe(false);
    expect(isManuallyRunnable(getCronJobDefinition("student_promotions_july_1")!)).toBe(false);
  });

  describe("Data Health Run buttons", () => {
    afterEach(() => vi.unstubAllEnvs());

    function stubFeatureFlags(enabled: boolean) {
      vi.stubEnv("WISE_CLASSROOM_AUTOMATION_ENABLED", enabled ? "true" : undefined);
      vi.stubEnv("FEEDBACK_AUTOWRITER_ENABLED", enabled ? "true" : undefined);
      vi.stubEnv("TUTOR_SIT_INS_ENABLED", enabled ? "true" : undefined);
      vi.stubEnv("CREDIT_CONTROL_MODE", enabled ? "active" : undefined);
    }

    it("offers every job except the excluded one when every feature is on", () => {
      stubFeatureFlags(true);
      const registry: readonly CronJobDefinition[] = CRON_JOBS;

      expect(manuallyRunnableCronJobs().map((job) => job.key)).toEqual(
        registry.filter((job) => job.manualRunDisabledReason === undefined).map((job) => job.key),
      );
    });

    it("hides jobs whose feature is paused, and never offers the excluded job", () => {
      stubFeatureFlags(false);
      const offered = manuallyRunnableCronJobs().map((job) => job.key);

      for (const paused of ["wise_snapshot", "classroom_morning", "feedback_autowriter", "tutor_sit_ins", "tutor_sit_ins_digest", "line_credit_digest"]) {
        expect(offered).not.toContain(paused);
      }
      expect(offered).not.toContain("student_promotions_july_1");
      expect(offered).toContain("unearned_revenue");
      expect(offered).toContain("line_backlog_recovery");
    });
  });
});
