import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEDULED_CRON_JOBS } from "../lib/data-health/cron-registry";

interface VercelConfig {
  crons: Array<{ path: string; schedule: string }>;
}

function loadVercelConfig(): VercelConfig {
  const configPath = new URL("../../vercel.json", import.meta.url);
  return JSON.parse(readFileSync(configPath, "utf8")) as VercelConfig;
}

describe("vercel cron configuration", () => {
  it("matches the Data Health scheduled cron registry", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.size).toBe(SCHEDULED_CRON_JOBS.length);
    for (const job of SCHEDULED_CRON_JOBS) {
      expect(crons.get(job.path)).toBe(job.schedule);
    }
  });

  it("points every deployed cron path at a GET route handler", () => {
    for (const cron of loadVercelConfig().crons) {
      const routePath = path.join(process.cwd(), "src", "app", ...cron.path.split("/").filter(Boolean), "route.ts");
      const source = readFileSync(routePath, "utf8");

      expect(source).toMatch(/export\s+(?:async\s+)?function\s+GET\b/);
    }
  });
});
