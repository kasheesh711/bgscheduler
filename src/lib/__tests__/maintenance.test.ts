import { describe, it, expect } from "vitest";

import {
  MAINTENANCE_EXEMPT_PREFIXES,
  isMaintenanceBypassEmail,
  isMaintenanceExempt,
  isMaintenanceMode,
  maintenanceBypassEmails,
  maintenanceResponse,
} from "@/lib/maintenance";

describe("isMaintenanceMode — MAINT-01 fail-open polarity", () => {
  it("engages only on the exact string \"true\"", () => {
    expect(isMaintenanceMode("true")).toBe(true);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["explicit false", "false"],
    ["uppercase TRUE", "TRUE"],
    ["mixed-case True", "True"],
    ["padded", " true "],
    ["numeric 1", "1"],
    ["yes", "yes"],
    ["typo", "ture"],
  ])("leaves the site up for %s", (_label, raw) => {
    expect(isMaintenanceMode(raw)).toBe(false);
  });

  it("a typo can never black out production — the failure direction is open", () => {
    // The inverse of ENABLE_STUDENT_SCHEDULE_LIVE (!== "false") on purpose:
    // that flag defaults on, this one defaults off.
    expect(isMaintenanceMode("enabled")).toBe(false);
    expect(isMaintenanceMode(undefined)).toBe(false);
  });
});

describe("isMaintenanceExempt — MAINT-02 exempt prefixes", () => {
  it.each([
    "/api/internal/sync-wise",
    "/api/internal/cron-watchdog",
    "/api/internal/post-class-feedback-backfill",
    "/schedule/abc123",
    "/api/auth/callback/google",
    "/api/auth/session",
    "/login",
    "/login?callbackUrl=%2Fsearch",
  ])("keeps %s reachable", (pathname) => {
    expect(isMaintenanceExempt(pathname)).toBe(true);
  });

  it.each([
    "/search",
    "/",
    "/payroll",
    "/api/compare",
    "/api/home/summary",
    "/api/line/webhook",
    "/data-health",
  ])("gates %s", (pathname) => {
    expect(isMaintenanceExempt(pathname)).toBe(false);
  });

  it("gates the authenticated /student-schedule admin page", () => {
    // The trailing slash on "/schedule/" is what separates these two.
    expect(isMaintenanceExempt("/student-schedule")).toBe(false);
    expect(isMaintenanceExempt("/schedule/tok")).toBe(true);
  });

  it("gates a bare /schedule with no token", () => {
    expect(isMaintenanceExempt("/schedule")).toBe(false);
  });

  it("gates /api/internal-ish paths that only look like the cron namespace", () => {
    expect(isMaintenanceExempt("/api/internal-tools")).toBe(false);
  });

  it("declares exactly the four documented prefixes", () => {
    expect([...MAINTENANCE_EXEMPT_PREFIXES]).toEqual([
      "/api/internal/",
      "/schedule/",
      "/api/auth/",
      "/login",
    ]);
  });
});

describe("maintenanceBypassEmails — MAINT-03 fail-closed allowlist", () => {
  it("yields an empty set when unset", () => {
    expect(maintenanceBypassEmails(undefined).size).toBe(0);
  });

  it("yields an empty set when empty or whitespace", () => {
    expect(maintenanceBypassEmails("").size).toBe(0);
    expect(maintenanceBypassEmails("   ").size).toBe(0);
    expect(maintenanceBypassEmails(",,").size).toBe(0);
  });

  it("parses a comma-separated list, trimming and lowercasing", () => {
    const parsed = maintenanceBypassEmails(" Kev@x.com , B@Y.CO ");
    expect([...parsed]).toEqual(["kev@x.com", "b@y.co"]);
  });
});

describe("isMaintenanceBypassEmail — MAINT-03", () => {
  const ALLOW = "kevhsh7@gmail.com,kevinhsieh711@gmail.com";

  it("admits a listed email", () => {
    expect(isMaintenanceBypassEmail("kevhsh7@gmail.com", ALLOW)).toBe(true);
  });

  it("admits regardless of case or surrounding whitespace", () => {
    expect(isMaintenanceBypassEmail("  KevHsh7@Gmail.com ", ALLOW)).toBe(true);
  });

  it("refuses an unlisted email", () => {
    expect(isMaintenanceBypassEmail("someone@else.com", ALLOW)).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
  ])("refuses a %s email", (_label, email) => {
    expect(isMaintenanceBypassEmail(email, ALLOW)).toBe(false);
  });

  it("refuses everyone when the allowlist is unset — fail-closed", () => {
    expect(isMaintenanceBypassEmail("kevhsh7@gmail.com", undefined)).toBe(false);
    expect(isMaintenanceBypassEmail("kevhsh7@gmail.com", "")).toBe(false);
  });
});

describe("maintenanceResponse — MAINT-05 response shape", () => {
  it("returns JSON with 503 for API paths", async () => {
    const res = maintenanceResponse("/api/compare");

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("3600");
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      error: "Service unavailable — maintenance mode",
    });
  });

  it("returns HTML with 503 for page paths", async () => {
    const res = maintenanceResponse("/search");

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("3600");
    expect(res.headers.get("content-type")).toContain("text/html");
    await expect(res.text()).resolves.toContain("down for maintenance");
  });

  it("marks the maintenance page noindex so it cannot be crawled as the site", async () => {
    const body = await maintenanceResponse("/search").text();

    expect(body).toContain("noindex");
  });
});
