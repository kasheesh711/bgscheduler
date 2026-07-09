import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/admissions/notifications", () => ({
  runDailyNotifications: vi.fn(),
  runWeeklyDigest: vi.fn(),
}));
vi.mock("@/lib/data-health/cron-audit", () => ({
  withCronInvocationAudit: vi.fn(),
}));

import { runDailyNotifications, runWeeklyDigest } from "@/lib/admissions/notifications";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { GET, POST } from "../route";

const dailyResult = {
  skipped: false,
  runId: "run-daily-1",
  runType: "daily" as const,
  sentCount: 2,
  skippedCount: 1,
  errorSummary: null,
};

const weeklyResult = {
  skipped: false,
  runId: "run-weekly-1",
  runType: "weekly" as const,
  sentCount: 5,
  skippedCount: 0,
  errorSummary: null,
};

/** Thursday 08:12 Asia/Bangkok (01:12 UTC). */
const BANGKOK_THURSDAY = new Date("2026-07-09T01:12:00.000Z");
/** Sunday 08:12 Asia/Bangkok (01:12 UTC). */
const BANGKOK_SUNDAY = new Date("2026-07-12T01:12:00.000Z");

function makeRequest(options: {
  secret?: string;
  method?: "GET" | "POST";
  query?: string;
  body?: string;
} = {}): NextRequest {
  const headers = options.secret === undefined
    ? undefined
    : { authorization: `Bearer ${options.secret}` };
  return new NextRequest(
    `http://test.local/api/internal/admissions-notifications${options.query ?? ""}`,
    { method: options.method ?? "GET", headers, body: options.body },
  );
}

describe("GET/POST /api/internal/admissions-notifications", () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(BANGKOK_THURSDAY);
    process.env.CRON_SECRET = "test-secret";
    vi.mocked(withCronInvocationAudit).mockImplementation(
      (_input, handler) => handler(),
    );
    vi.mocked(runDailyNotifications).mockResolvedValue(dailyResult);
    vi.mocked(runWeeklyDigest).mockResolvedValue(weeklyResult);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it("rejects GET with a wrong cron secret", async () => {
    const res = await GET(makeRequest({ secret: "wrong-secret" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(runDailyNotifications).not.toHaveBeenCalled();
    expect(runWeeklyDigest).not.toHaveBeenCalled();
  });

  it("returns 500 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(makeRequest({}));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Server misconfigured" });
    expect(runDailyNotifications).not.toHaveBeenCalled();
  });

  it("runs only the daily scan by default on a non-Sunday", async () => {
    const res = await GET(makeRequest({ secret: "test-secret" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      skipped: false,
      results: [
        { ...dailyResult },
      ],
    });
    expect(runDailyNotifications).toHaveBeenCalledTimes(1);
    expect(runWeeklyDigest).not.toHaveBeenCalled();
    expect(withCronInvocationAudit).toHaveBeenCalledWith(
      { jobKey: "admissions_notifications", triggerSource: "cron", requestMethod: "GET" },
      expect.any(Function),
    );
  });

  it("also runs the weekly digest by default on a Bangkok Sunday", async () => {
    vi.setSystemTime(BANGKOK_SUNDAY);

    const res = await GET(makeRequest({ secret: "test-secret" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0].runType).toBe("daily");
    expect(body.results[1].runType).toBe("weekly");
    expect(runDailyNotifications).toHaveBeenCalledTimes(1);
    expect(runWeeklyDigest).toHaveBeenCalledTimes(1);
  });

  it("runs only the weekly digest for an explicit runType=weekly query param", async () => {
    const res = await GET(makeRequest({ secret: "test-secret", query: "?runType=weekly" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([{ ...weeklyResult }]);
    expect(runWeeklyDigest).toHaveBeenCalledTimes(1);
    expect(runDailyNotifications).not.toHaveBeenCalled();
  });

  it("rejects an unknown runType query param with 400", async () => {
    const res = await GET(makeRequest({ secret: "test-secret", query: "?runType=hourly" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid runType" });
    expect(runDailyNotifications).not.toHaveBeenCalled();
    expect(runWeeklyDigest).not.toHaveBeenCalled();
  });

  it("accepts an explicit runType in a POST body", async () => {
    const res = await POST(makeRequest({
      secret: "test-secret",
      method: "POST",
      body: JSON.stringify({ runType: "weekly" }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([{ ...weeklyResult }]);
    expect(runWeeklyDigest).toHaveBeenCalledTimes(1);
    expect(runDailyNotifications).not.toHaveBeenCalled();
  });

  it("treats an empty POST body as the daily default", async () => {
    const res = await POST(makeRequest({ secret: "test-secret", method: "POST" }));

    expect(res.status).toBe(200);
    expect(runDailyNotifications).toHaveBeenCalledTimes(1);
    expect(runWeeklyDigest).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON in a POST body with 400", async () => {
    const res = await POST(makeRequest({
      secret: "test-secret",
      method: "POST",
      body: "{not json",
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(runDailyNotifications).not.toHaveBeenCalled();
  });

  it("rejects an invalid runType in a POST body with 400", async () => {
    const res = await POST(makeRequest({
      secret: "test-secret",
      method: "POST",
      body: JSON.stringify({ runType: "monthly" }),
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid runType" });
    expect(runDailyNotifications).not.toHaveBeenCalled();
    expect(runWeeklyDigest).not.toHaveBeenCalled();
  });

  it("returns 202 when the single-flight guard skips every run", async () => {
    vi.mocked(runDailyNotifications).mockResolvedValue({
      ...dailyResult,
      skipped: true,
      runId: null,
      sentCount: 0,
      skippedCount: 0,
    });

    const res = await GET(makeRequest({ secret: "test-secret" }));

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.results[0].skipped).toBe(true);
  });

  it("returns 200 on Sundays when only one of the two runs is skipped", async () => {
    vi.setSystemTime(BANGKOK_SUNDAY);
    vi.mocked(runDailyNotifications).mockResolvedValue({
      ...dailyResult,
      skipped: true,
      runId: null,
      sentCount: 0,
      skippedCount: 0,
    });

    const res = await GET(makeRequest({ secret: "test-secret" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.results).toHaveLength(2);
  });

  it("returns 500 when an orchestrator crashes", async () => {
    vi.mocked(runDailyNotifications).mockRejectedValue(new Error("db unreachable"));

    const res = await GET(makeRequest({ secret: "test-secret" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "db unreachable" });
  });
});
