import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface VercelConfig {
  crons: Array<{ path: string; schedule: string }>;
}

const EXPECTED_CRONS = [
  { path: "/api/internal/class-assignments/admin-email", schedule: "0,10,20,30 0 * * *" },
  { path: "/api/internal/class-assignments/morning", schedule: "45 23 * * *" },
  { path: "/api/internal/cron-watchdog", schedule: "7,37 * * * *" },
  { path: "/api/internal/progress-tests/admin-digest", schedule: "35 0 * * *" },
  { path: "/api/internal/student-promotions/july-1", schedule: "5 17 30 6 *" },
  { path: "/api/internal/sync-competitor-intelligence", schedule: "25 18 * * 0" },
  { path: "/api/internal/sync-credit-control", schedule: "20,50 * * * *" },
  { path: "/api/internal/sync-leave-requests", schedule: "15,45 * * * *" },
  { path: "/api/internal/sync-progress-tests", schedule: "25,55 * * * *" },
  { path: "/api/internal/sync-sales-dashboard", schedule: "10,40 * * * *" },
  { path: "/api/internal/sync-wise", schedule: "*/30 * * * *" },
  { path: "/api/internal/sync-wise-activity", schedule: "5,35 * * * *" },
] as const;

const THIRTY_MINUTE_SYNC_PATHS = [
  "/api/internal/sync-wise",
  "/api/internal/sync-wise-activity",
  "/api/internal/sync-sales-dashboard",
  "/api/internal/sync-leave-requests",
  "/api/internal/sync-credit-control",
  "/api/internal/sync-progress-tests",
] as const;

function loadVercelConfig(): VercelConfig {
  const configPath = new URL("../../vercel.json", import.meta.url);
  return JSON.parse(readFileSync(configPath, "utf8")) as VercelConfig;
}

function byPath(a: { path: string }, b: { path: string }) {
  return a.path.localeCompare(b.path);
}

function cronMinutes(schedule: string): number[] {
  const [minuteField] = schedule.split(" ");

  if (minuteField === "*/30") {
    return [0, 30];
  }

  return minuteField.split(",").map((minute) => Number(minute));
}

describe("vercel cron configuration", () => {
  it("keeps the deployed cron schedule inventory under regression coverage", () => {
    const crons = loadVercelConfig().crons;
    const paths = crons.map((cron) => cron.path);

    expect(new Set(paths).size).toBe(paths.length);
    expect([...crons].sort(byPath)).toEqual([...EXPECTED_CRONS].sort(byPath));
  });

  it("staggers every 30-minute sync job at a five-minute offset", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    const firstHalfHourMinutes = THIRTY_MINUTE_SYNC_PATHS.map((path) => cronMinutes(crons.get(path) ?? "")[0]);
    const allSyncMinutes = THIRTY_MINUTE_SYNC_PATHS.flatMap((path) => cronMinutes(crons.get(path) ?? ""));

    expect(firstHalfHourMinutes).toEqual([0, 5, 10, 15, 20, 25]);
    expect(allSyncMinutes).toEqual([0, 30, 5, 35, 10, 40, 15, 45, 20, 50, 25, 55]);
    expect(new Set(allSyncMinutes).size).toBe(allSyncMinutes.length);
  });

  it("keeps the classroom daily automation and admin-email retry window pinned to Bangkok mornings", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.get("/api/internal/class-assignments/morning")).toBe("45 23 * * *");
    expect(crons.get("/api/internal/class-assignments/admin-email")).toBe("0,10,20,30 0 * * *");
  });
});
