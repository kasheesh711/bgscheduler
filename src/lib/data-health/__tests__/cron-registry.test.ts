import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CRON_JOBS, SCHEDULED_CRON_JOBS } from "../cron-registry";

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
});
