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

  it("models Student Promotions as a one-shot Bangkok date", () => {
    const job = CRON_JOBS.find((candidate) => candidate.key === "student_promotions_july_1");

    expect(job).toMatchObject({
      schedule: "5 17 30 6 *",
      expectedBangkokDate: "2026-07-01",
      expectedBangkokMinute: 5,
    });
  });

  it("matches registered route methods to exported route handlers", () => {
    for (const job of CRON_JOBS) {
      const routePath = path.join(process.cwd(), "src", "app", ...job.path.split("/").filter(Boolean), "route.ts");
      const source = readFileSync(routePath, "utf8");

      expect(source).toMatch(new RegExp(`export\\s+(?:async\\s+)?function\\s+${job.routeMethod}\\b`));
    }
  });
});
