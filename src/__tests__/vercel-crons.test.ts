import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface VercelConfig {
  crons: Array<{ path: string; schedule: string }>;
}

const EXPECTED_CRONS: VercelConfig["crons"] = [
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
];

const HALF_HOUR_SYNC_PATHS = [
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

function sortCrons(crons: VercelConfig["crons"]): VercelConfig["crons"] {
  return [...crons].sort((a, b) => a.path.localeCompare(b.path));
}

function firstScheduledMinute(schedule: string): number {
  const [minuteField] = schedule.split(" ");
  if (minuteField === "*/30") return 0;
  const firstMinute = Number(minuteField.split(",")[0]);
  if (!Number.isInteger(firstMinute)) {
    throw new Error(`Unsupported cron minute field: ${minuteField}`);
  }
  return firstMinute;
}

describe("vercel cron configuration", () => {
  it("matches the complete deployed cron schedule contract", () => {
    expect(sortCrons(loadVercelConfig().crons)).toEqual(sortCrons(EXPECTED_CRONS));
  });

  it("keeps high-frequency sync jobs staggered at five-minute offsets", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));
    const observedOffsets = HALF_HOUR_SYNC_PATHS.map((path) => {
      const schedule = crons.get(path);
      if (!schedule) throw new Error(`Missing cron schedule for ${path}`);
      return firstScheduledMinute(schedule);
    });

    expect(observedOffsets).toEqual([0, 5, 10, 15, 20, 25]);
    expect(new Set(observedOffsets).size).toBe(HALF_HOUR_SYNC_PATHS.length);
  });
});
