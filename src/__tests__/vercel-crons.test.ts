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
  it("runs Wise, Wise Activity, Sales Dashboard, and Credit Control on staggered 30-minute schedules", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.get("/api/internal/sync-wise")).toBe("*/30 * * * *");
    expect(crons.get("/api/internal/sync-wise-activity")).toBe("5,35 * * * *");
    expect(crons.get("/api/internal/sync-sales-dashboard")).toBe("10,40 * * * *");
    expect(crons.get("/api/internal/sync-credit-control")).toBe("20,50 * * * *");
  });

  it("runs the admissions notifications scan daily at 08:12 Bangkok (01:12 UTC)", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.get("/api/internal/admissions-notifications")).toBe("12 1 * * *");
  });

  it("staggers the admissions notifications cron away from every other cron minute", () => {
    const otherMinuteFields = loadVercelConfig()
      .crons.filter((cron) => cron.path !== "/api/internal/admissions-notifications")
      .map((cron) => cron.schedule.split(" ")[0]);
    const usedMinutes = new Set(
      otherMinuteFields.flatMap((field) =>
        field === "*/30" ? [0, 30] : field.split(",").map((minute) => Number(minute)),
      ),
    );

    expect(usedMinutes.has(12)).toBe(false);
  });
});
