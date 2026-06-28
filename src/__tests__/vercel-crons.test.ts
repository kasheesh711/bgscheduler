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

  it("registers the Student Promotions July 1 one-shot Bangkok cron", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.get("/api/internal/student-promotions/july-1")).toBe("5 17 30 6 *");
  });
});
