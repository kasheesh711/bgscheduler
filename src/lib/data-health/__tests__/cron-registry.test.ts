import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CRON_JOBS, SCHEDULED_CRON_JOBS } from "../cron-registry";

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

  it("declares the room utilization sync as manual-only", () => {
    const paths = SCHEDULED_CRON_JOBS.map((job) => job.path as string);
    expect(paths).not.toContain("/api/internal/sync-room-utilization");
  });

  it("matches registered route methods to exported route handlers", () => {
    for (const job of CRON_JOBS) {
      const routePath = path.join(process.cwd(), "src", "app", ...job.path.split("/").filter(Boolean), "route.ts");
      const source = readFileSync(routePath, "utf8");

      expect(source).toMatch(new RegExp(`export\\s+(?:async\\s+)?function\\s+${job.routeMethod}\\b`));
    }
  });
});
