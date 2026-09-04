import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface VercelConfig {
  crons: Array<{ path: string; schedule: string }>;
}

function loadVercelConfig(): VercelConfig {
  const configPath = new URL("../../vercel.json", import.meta.url);
  return JSON.parse(readFileSync(configPath, "utf8")) as VercelConfig;
}

/**
 * Every schedule, pinned. Vercel gives no staging environment for cron
 * timing, so the only place a stagger regression can be caught is here.
 */
const EXPECTED_SCHEDULES: Record<string, string> = {
  "/api/internal/sync-wise": "*/30 * * * *",
  "/api/internal/sync-sales-dashboard": "10,40 * * * *",
  "/api/internal/sync-unearned-revenue": "30 18 * * *",
  "/api/internal/sync-onsite-foot-traffic": "18 18 * * *",
  "/api/internal/sync-competitor-intelligence": "28 18 * * 0",
  "/api/internal/sync-credit-control": "20,50 * * * *",
  "/api/internal/sync-progress-tests": "25,55 * * * *",
  "/api/internal/progress-tests/admin-digest": "35 0 * * *",
  "/api/internal/sync-wise-activity": "2,17,32,47 * * * *",
  "/api/internal/sync-post-class-feedback": "13,43 * * * *",
  "/api/internal/post-class-feedback-backfill": "23,53 * * * *",
  "/api/internal/post-class-feedback/payout-accrual": "33 * * * *",
  "/api/internal/sync-leave-requests": "15,45 * * * *",
  "/api/internal/class-assignments/morning": "41 23 * * *",
  "/api/internal/class-assignments/admin-email": "4,14,24,36 0 * * *",
  "/api/internal/student-promotions/july-1": "5 17 30 6 *",
  "/api/internal/cron-watchdog": "7,37 * * * *",
  "/api/internal/admissions-notifications": "12 1 * * *",
  "/api/internal/line-credit-digest": "3 2 * * *",
};

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/** Expand one cron field — wildcard, comma list, range, or step — into its values. */
function expandField(field: string, min: number, max: number): Set<number> {
  const values = field.split(",").flatMap((part) => {
    const step = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(part);
    if (step) {
      const base = step[1] === "*" ? range(min, max) : expandSpan(step[1], min, max);
      const every = Number(step[2]);
      return base.filter((value) => (value - base[0]) % every === 0);
    }
    return expandSpan(part, min, max);
  });
  return new Set(values);
}

function expandSpan(part: string, min: number, max: number): number[] {
  if (part === "*") return range(min, max);
  const span = /^(\d+)-(\d+)$/.exec(part);
  if (span) return range(Number(span[1]), Number(span[2]));
  return [Number(part)];
}

interface FiringSet {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function firingSet(schedule: string): FiringSet {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.split(" ");
  return {
    minutes: expandField(minute, 0, 59),
    hours: expandField(hour, 0, 23),
    daysOfMonth: expandField(dayOfMonth, 1, 31),
    months: expandField(month, 1, 12),
    daysOfWeek: expandField(dayOfWeek, 0, 6),
  };
}

function intersects(left: Set<number>, right: Set<number>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

/** True when both schedules can fire in the same UTC minute. */
function canCollide(left: FiringSet, right: FiringSet): boolean {
  return (
    intersects(left.minutes, right.minutes) &&
    intersects(left.hours, right.hours) &&
    intersects(left.daysOfMonth, right.daysOfMonth) &&
    intersects(left.months, right.months) &&
    intersects(left.daysOfWeek, right.daysOfWeek)
  );
}

describe("vercel cron configuration", () => {
  it("registers exactly the 19 known crons, each on its pinned schedule", () => {
    const crons = loadVercelConfig().crons;

    expect(crons).toHaveLength(19);
    expect(Object.fromEntries(crons.map((cron) => [cron.path, cron.schedule]))).toEqual(EXPECTED_SCHEDULES);
  });

  // Two crons firing in the same UTC minute contend for the same Wise rate
  // limit and Neon connection pool. Six such collisions existed while daily
  // calendar jobs sat on minutes the half-hourly syncs already owned, so the
  // check expands each schedule rather than eyeballing the minute field.
  it("gives every cron a UTC minute no other cron can fire in", () => {
    const crons = loadVercelConfig().crons.map((cron) => ({
      path: cron.path,
      firing: firingSet(cron.schedule),
    }));

    const collisions: string[] = [];
    for (let i = 0; i < crons.length; i += 1) {
      for (let j = i + 1; j < crons.length; j += 1) {
        const pair = new Set([crons[i].path, crons[j].path]);
        // Finance specified an exact 01:30 Bangkok cutoff import. Its only
        // overlap is the half-hour Wise snapshot; the finance job reads
        // Google Sheets/Postgres and never calls or mutates Wise.
        const approvedFinanceOverlap = pair.has("/api/internal/sync-wise")
          && pair.has("/api/internal/sync-unearned-revenue");
        if (canCollide(crons[i].firing, crons[j].firing) && !approvedFinanceOverlap) {
          collisions.push(`${crons[i].path} vs ${crons[j].path}`);
        }
      }
    }

    expect(collisions).toEqual([]);
  });

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

  it("arms the payout accrual hourly for unattended charging", () => {
    const crons = new Map(loadVercelConfig().crons.map((cron) => [cron.path, cron.schedule]));

    expect(crons.get("/api/internal/post-class-feedback/payout-accrual")).toBe("33 * * * *");
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
