/**
 * The activation gate's HTTP surface, which had no test at all.
 *
 * This is the last onboarding check before the feature can deduct from real
 * tutors' pay, and it is now overridable by an acknowledgement — so the
 * stale-count rejection below is the assertion that matters most. Without it a
 * tab left open overnight could wave through a number that has since grown.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/post-class-feedback/access", () => ({
  requirePostClassCapability: vi.fn(),
}));
vi.mock("@/lib/post-class-feedback/api", () => ({
  postClassFeedbackErrorResponse: vi.fn((_scope, error: unknown, fallback: string) =>
    NextResponse.json(
      { error: error instanceof Error ? error.message : fallback },
      { status: error instanceof Error && error.name === "PostClassConflictError" ? 409 : 400 },
    )),
}));
vi.mock("@/lib/post-class-feedback/repository", () => ({
  countOpenBlockingGlobalSourceIssues: vi.fn(),
}));
vi.mock("@/lib/post-class-feedback/settings", () => ({
  markPostClassShadowReviewed: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => fakeDb) }));

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { countOpenBlockingGlobalSourceIssues } from "@/lib/post-class-feedback/repository";
import { markPostClassShadowReviewed } from "@/lib/post-class-feedback/settings";
import * as schema from "@/lib/db/schema";
import { POST } from "../route";

const MAPPING_UPDATED_AT = new Date("2026-07-21T02:00:00.000Z");

interface FakeState {
  settings: Record<string, unknown> | null;
  mappings: Array<{ updatedAt: Date }>;
  syncRuns: Array<Record<string, unknown>>;
}

let state: FakeState;

/** Routes each `select().from(table)` to its fixture; the route awaits directly. */
const fakeDb = {
  select() {
    return {
      from(table: unknown) {
        const rows = table === schema.postClassSettings
          ? (state.settings ? [state.settings] : [])
          : table === schema.postClassFieldMappings
            ? state.mappings
            : state.syncRuns;
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve(rows),
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
        return chain;
      },
    };
  },
} as never;

function syncRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "sync-1",
    finishedAt: new Date("2026-07-21T03:00:00.000Z"),
    detailFetchedCount: 10,
    sessionCount: 10,
    assessedCount: 9,
    metadata: {
      policyVersion: 1,
      mappingVersion: 1,
      candidateCount: 10,
      readySessionCount: 10,
      globalSourceHealthy: true,
      mappingObservedHealthy: true,
    },
    ...overrides,
  };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://app.test/api/post-class-feedback/shadow-review", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state = {
    settings: {
      id: "default",
      enforcementMode: "shadow",
      version: 3,
      policyVersion: 1,
      formMappingVersion: 1,
    },
    mappings: [{ updatedAt: MAPPING_UPDATED_AT }],
    syncRuns: [syncRun()],
  };
  vi.mocked(requirePostClassCapability).mockResolvedValue({
    email: "manager@example.com",
  } as never);
  vi.mocked(countOpenBlockingGlobalSourceIssues).mockResolvedValue(0);
  vi.mocked(markPostClassShadowReviewed).mockResolvedValue({ id: "default" } as never);
});

describe("POST /api/post-class-feedback/shadow-review", () => {
  it("confirms a clean shadow sync", async () => {
    const response = await POST(request({ expectedVersion: 3 }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ evidenceSyncRunId: "sync-1" });
    expect(markPostClassShadowReviewed).toHaveBeenCalledWith(
      "manager@example.com",
      expect.anything(),
      3,
      "sync-1",
      expect.objectContaining({ acknowledgedSessionIssues: null }),
    );
  });

  it("refuses when the capability check rejects", async () => {
    vi.mocked(requirePostClassCapability).mockRejectedValue(new Error("Forbidden"));

    const response = await POST(request({ expectedVersion: 3 }));

    expect(response.status).toBe(400);
    expect(markPostClassShadowReviewed).not.toHaveBeenCalled();
  });

  it("refuses outside shadow mode", async () => {
    state.settings = { ...state.settings, enforcementMode: "live" };

    const response = await POST(request({ expectedVersion: 3 }));

    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("shadow mode"),
    });
    expect(markPostClassShadowReviewed).not.toHaveBeenCalled();
  });

  it("refuses a stale settings version", async () => {
    const response = await POST(request({ expectedVersion: 2 }));

    expect(response.status).toBe(409);
    expect(markPostClassShadowReviewed).not.toHaveBeenCalled();
  });

  it("refuses without an active mapping", async () => {
    state.mappings = [];

    const response = await POST(request({ expectedVersion: 3 }));

    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("form mapping"),
    });
  });

  it("names the failing condition instead of one undifferentiated sentence", async () => {
    state.syncRuns = [syncRun({
      metadata: { ...syncRun().metadata, globalSourceHealthy: false },
    })];

    const response = await POST(request({ expectedVersion: 3 }));

    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("source health run-wide"),
    });
    expect(markPostClassShadowReviewed).not.toHaveBeenCalled();
  });

  it("blocks on an open blocking global issue and says so", async () => {
    vi.mocked(countOpenBlockingGlobalSourceIssues).mockResolvedValue(2);

    const response = await POST(request({ expectedVersion: 3 }));

    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("2 blocking global source issues are still open"),
    });
  });

  describe("acknowledgement", () => {
    beforeEach(() => {
      state.syncRuns = [syncRun({
        metadata: { ...syncRun().metadata, readySessionCount: 4 },
      })];
    });

    it("reports the exact count to acknowledge", async () => {
      const response = await POST(request({ expectedVersion: 3 }));

      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("Acknowledge the exact count (6)"),
      });
      expect(markPostClassShadowReviewed).not.toHaveBeenCalled();
    });

    it("rejects a stale count from a tab left open", async () => {
      const response = await POST(request({
        expectedVersion: 3,
        acknowledgeSessionIssues: 5,
        reason: "Checked them all in Wise.",
      }));

      expect(response.status).toBe(400);
      expect(markPostClassShadowReviewed).not.toHaveBeenCalled();
    });

    it("rejects the exact count with no reason", async () => {
      const response = await POST(request({
        expectedVersion: 3,
        acknowledgeSessionIssues: 6,
      }));

      expect(response.status).toBe(400);
      expect(markPostClassShadowReviewed).not.toHaveBeenCalled();
    });

    it("accepts the exact count with a reason and records both", async () => {
      const response = await POST(request({
        expectedVersion: 3,
        acknowledgeSessionIssues: 6,
        reason: "Six classes deleted in Wise on 25 July; verified.",
      }));

      expect(response.status).toBe(200);
      expect(markPostClassShadowReviewed).toHaveBeenCalledWith(
        "manager@example.com",
        expect.anything(),
        3,
        "sync-1",
        expect.objectContaining({
          acknowledgedSessionIssues: 6,
          reason: "Six classes deleted in Wise on 25 July; verified.",
        }),
      );
    });
  });
});
