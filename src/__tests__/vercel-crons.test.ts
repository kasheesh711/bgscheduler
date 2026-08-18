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
  it("runs Wise, Sales Dashboard, and Credit Control on staggered 30-minute schedules", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.get("/api/internal/sync-wise")).toBe("*/30 * * * *");
    expect(crons.get("/api/internal/sync-sales-dashboard")).toBe("10,40 * * * *");
    expect(crons.get("/api/internal/sync-credit-control")).toBe("20,50 * * * *");
  });

  // The activity mirror is the only source of feedback-submission timestamps,
  // so it runs at 15-minute intervals rather than the 30 every other sync uses:
  // an event written minutes before a 23:59:59.999 Bangkok deadline is then
  // mirrored the same evening instead of after midnight. This is a freshness
  // change only — the verdict always reads the event's own immutable timestamp.
  it("runs the Wise Activity mirror every 15 minutes on free stagger minutes", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.get("/api/internal/sync-wise-activity")).toBe("2,17,32,47 * * * *");
  });

  it("keeps the Wise Activity mirror clear of every other cron minute", () => {
    const otherMinuteFields = loadVercelConfig()
      .crons.filter((cron) => cron.path !== "/api/internal/sync-wise-activity")
      .map((cron) => cron.schedule.split(" ")[0]);
    const usedMinutes = new Set(
      otherMinuteFields.flatMap((field) =>
        field === "*/30" ? [0, 30] : field.split(",").map((minute) => Number(minute)),
      ),
    );

    for (const minute of [2, 17, 32, 47]) {
      expect(usedMinutes.has(minute)).toBe(false);
    }
  });

  it("runs the admissions notifications scan daily at 08:12 Bangkok (01:12 UTC)", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.get("/api/internal/admissions-notifications")).toBe("12 1 * * *");
  });

  it("runs the LINE credit digest daily at 09:03 Bangkok (02:03 UTC)", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.get("/api/internal/line-credit-digest")).toBe("3 2 * * *");
  });

  it("staggers the LINE credit digest away from every other cron minute", () => {
    const otherMinuteFields = loadVercelConfig()
      .crons.filter((cron) => cron.path !== "/api/internal/line-credit-digest")
      .map((cron) => cron.schedule.split(" ")[0]);
    const usedMinutes = new Set(
      otherMinuteFields.flatMap((field) =>
        field === "*/30" ? [0, 30] : field.split(",").map((minute) => Number(minute)),
      ),
    );

    expect(usedMinutes.has(3)).toBe(false);
  });

  it("runs the payout accrual hourly on minute 33", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.get("/api/internal/post-class-feedback/payout-accrual")).toBe("33 * * * *");
  });

  it("staggers the payout accrual away from every other cron minute", () => {
    const otherMinuteFields = loadVercelConfig()
      .crons.filter((cron) => cron.path !== "/api/internal/post-class-feedback/payout-accrual")
      .map((cron) => cron.schedule.split(" ")[0]);
    const usedMinutes = new Set(
      otherMinuteFields.flatMap((field) =>
        field === "*/30" ? [0, 30] : field.split(",").map((minute) => Number(minute)),
      ),
    );

    expect(usedMinutes.has(33)).toBe(false);
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
