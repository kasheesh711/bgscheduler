import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/feedback-autowriter/dispatch", () => ({ runAutowriterJob: vi.fn() }));
vi.mock("@/lib/class-capture/cleanup", () => ({ cleanupClassCaptures: vi.fn() }));

import { getDb } from "@/lib/db";
import { runAutowriterJob } from "@/lib/feedback-autowriter/dispatch";
import { cleanupClassCaptures } from "@/lib/class-capture/cleanup";
import { GET } from "../route";

const retention = { enabled: true, ok: true, cleaned: 2, failed: 0, deferred: 0 };
let updates: Record<string, unknown>[];

function request(secret = "synthetic-cron-secret") {
  return new NextRequest("https://example.test/api/internal/feedback-autowriter", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", "synthetic-cron-secret");
  updates = [];
  vi.mocked(getDb).mockReturnValue({
    insert: () => ({ values: () => ({ returning: async () => [{ id: "synthetic-invocation" }] }) }),
    update: () => ({ set: (value: Record<string, unknown>) => {
      updates.push(value);
      return { where: async () => [] };
    } }),
  } as never);
  vi.mocked(runAutowriterJob).mockResolvedValue({ ok: true, skipped: true, reason: "Autowriter disabled" });
  vi.mocked(cleanupClassCaptures).mockResolvedValue(retention);
});

afterEach(() => vi.unstubAllEnvs());

describe("capture retention evidence in the scheduled autowriter audit", () => {
  it("rejects an invalid cron secret before either worker or audit writes", async () => {
    expect((await GET(request("wrong-secret"))).status).toBe(401);
    expect(runAutowriterJob).not.toHaveBeenCalled();
    expect(cleanupClassCaptures).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([
    { label: "successful enabled sweep", result: retention, status: 200 },
    { label: "disabled cleanup", result: { enabled: false, ok: true, cleaned: 0, failed: 0, deferred: 0 }, status: 200 },
    { label: "failed and deferred work", result: { enabled: true, ok: false, cleaned: 1, failed: 2, deferred: 3 }, status: 503 },
  ])("persists the actual $label even when the autowriter is skipped", async ({ result, status }) => {
    vi.mocked(cleanupClassCaptures).mockResolvedValue(result);
    const response = await GET(request());
    expect(response.status).toBe(status);
    const fields = {
      captureRetentionEnabled: result.enabled,
      captureRetentionOk: result.ok,
      captureRetentionCleaned: result.cleaned,
      captureRetentionFailed: result.failed,
      captureRetentionDeferred: result.deferred,
    };
    expect(await response.json()).toMatchObject({ captureRetention: result, ...fields });
    // Exercise the real audit wrapper and digest: nested objects alone become keyCount.
    expect(updates).toEqual([expect.objectContaining({
      responseStatus: status,
      metadata: { response: expect.objectContaining({ ...fields, captureRetention: { keyCount: 5 } }) },
    })]);
    expect(runAutowriterJob).toHaveBeenCalledTimes(1);
    expect(cleanupClassCaptures).toHaveBeenCalledTimes(1);
  });

  it("records a rejected sweep as failed with unknown counts, not a successful zero backlog", async () => {
    vi.mocked(cleanupClassCaptures).mockRejectedValue(new Error("Synthetic storage failure"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(updates).toEqual([expect.objectContaining({
      metadata: { response: expect.objectContaining({
        captureRetentionEnabled: true,
        captureRetentionOk: false,
        captureRetentionCleaned: null,
        captureRetentionFailed: 1,
        captureRetentionDeferred: null,
      }) },
    })]);
    expect(JSON.stringify(updates)).not.toContain("Synthetic storage failure");
  });
});
