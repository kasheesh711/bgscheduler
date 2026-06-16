import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface VercelConfig {
  crons: Array<{ path: string; schedule: string }>;
}

function loadVercelConfig(): VercelConfig {
  const configPath = new URL("../../vercel.json", import.meta.url);
  return JSON.parse(readFileSync(configPath, "utf8")) as VercelConfig;
}

describe("vercel cron configuration", () => {
  it("declares every deployed cron schedule", () => {
    expect(loadVercelConfig().crons).toEqual([
      { path: "/api/internal/sync-wise", schedule: "*/30 * * * *" },
      { path: "/api/internal/sync-sales-dashboard", schedule: "10,40 * * * *" },
      { path: "/api/internal/sync-competitor-intelligence", schedule: "25 18 * * 0" },
      { path: "/api/internal/sync-credit-control", schedule: "20,50 * * * *" },
      { path: "/api/internal/sync-progress-tests", schedule: "25,55 * * * *" },
      { path: "/api/internal/progress-tests/admin-digest", schedule: "35 0 * * *" },
      { path: "/api/internal/sync-wise-activity", schedule: "5,35 * * * *" },
      { path: "/api/internal/sync-leave-requests", schedule: "15,45 * * * *" },
      { path: "/api/internal/class-assignments/morning", schedule: "45 23 * * *" },
      { path: "/api/internal/class-assignments/admin-email", schedule: "0,10,20,30 0 * * *" },
      { path: "/api/internal/student-promotions/july-1", schedule: "5 17 30 6 *" },
      { path: "/api/internal/cron-watchdog", schedule: "7,37 * * * *" },
    ]);
  });

  it("points each deployed cron at an existing GET route handler", () => {
    for (const cron of loadVercelConfig().crons) {
      const routePath = new URL(`../app/${cron.path.replace(/^\//, "")}/route.ts`, import.meta.url);
      expect(existsSync(routePath), cron.path).toBe(true);

      const source = readFileSync(routePath, "utf8");
      expect(source, cron.path).toMatch(/export\s+(?:async\s+)?function\s+GET\b/);
    }
  });
});
