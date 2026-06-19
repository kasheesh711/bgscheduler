import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface VercelConfig {
  crons: Array<{ path: string; schedule: string }>;
}

function loadVercelConfig(): VercelConfig {
  const configPath = new URL("../../vercel.json", import.meta.url);
  return JSON.parse(readFileSync(configPath, "utf8")) as VercelConfig;
}

describe("vercel cron configuration", () => {
  it("registers every deployed Vercel cron on its expected schedule", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(Object.fromEntries([...crons.entries()].sort())).toEqual({
      "/api/internal/class-assignments/admin-email": "0,10,20,30 0 * * *",
      "/api/internal/class-assignments/morning": "45 23 * * *",
      "/api/internal/cron-watchdog": "7,37 * * * *",
      "/api/internal/progress-tests/admin-digest": "35 0 * * *",
      "/api/internal/student-promotions/july-1": "5 17 30 6 *",
      "/api/internal/sync-competitor-intelligence": "25 18 * * 0",
      "/api/internal/sync-credit-control": "20,50 * * * *",
      "/api/internal/sync-leave-requests": "15,45 * * * *",
      "/api/internal/sync-progress-tests": "25,55 * * * *",
      "/api/internal/sync-sales-dashboard": "10,40 * * * *",
      "/api/internal/sync-wise": "*/30 * * * *",
      "/api/internal/sync-wise-activity": "5,35 * * * *",
    });
  });
});
