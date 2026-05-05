import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";
import type { IndexedTutorGroup, SearchIndex } from "@/lib/search/index";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
vi.mock("@/lib/data/past-sessions", () => ({
  fetchPastSessionBlocks: vi.fn().mockResolvedValue(new Map()),
}));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fetchPastSessionBlocks } from "@/lib/data/past-sessions";
import { ensureIndex } from "@/lib/search/index";
import { POST } from "@/app/api/compare/route";

const authMock = auth as unknown as Mock;

function makeTutorGroup(overrides: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup {
  return {
    id: "g1",
    canonicalKey: "test",
    displayName: "Test Tutor",
    supportedModes: ["online"],
    qualifications: [{ subject: "Math", curriculum: "IB", level: "Grade 10" }],
    wiseRecords: [{ wiseTeacherId: "wise-1", wiseDisplayName: "Test Tutor", isOnline: true }],
    availabilityWindows: [
      { weekday: 1, startMinute: 900, endMinute: 1020, modality: "online", wiseTeacherId: "wise-1" },
    ],
    leaves: [],
    sessionBlocks: [],
    dataIssues: [],
    ...overrides,
  };
}

function makeIndex(groups: IndexedTutorGroup[] = [makeTutorGroup()]): SearchIndex {
  return {
    snapshotId: "snap-1",
    builtAt: new Date("2026-04-06T00:00:00.000Z"),
    tutorGroups: groups,
    byWeekday: new Map([[1, groups]]),
  };
}

describe("POST /api/compare", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } });
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(fetchPastSessionBlocks).mockResolvedValue(new Map() as never);
    vi.mocked(ensureIndex).mockResolvedValue(makeIndex() as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRequest(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ tutorGroupIds: ["g1"], mode: "recurring" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 400 when body fails Zod validation", async () => {
    const res = await POST(makeRequest({ tutorGroupIds: [], mode: "recurring" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
    expect(body.details).toBeDefined();
  });

  it("returns 200 with compare response shape on success", async () => {
    const res = await POST(
      makeRequest({ tutorGroupIds: ["g1"], mode: "recurring", weekStart: "2026-04-06" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      snapshotMeta: expect.objectContaining({ snapshotId: "snap-1", stale: expect.any(Boolean) }),
      tutors: [
        expect.objectContaining({
          tutorGroupId: "g1",
          displayName: "Test Tutor",
          sessions: [],
        }),
      ],
      conflicts: [],
      sharedFreeSlots: [expect.objectContaining({ dayOfWeek: 1 })],
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      latencyMs: expect.any(Number),
      warnings: expect.any(Array),
    });
  });

  it("marks snapshot metadata stale only after the 26-hour API threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T02:00:00.000Z"));
    const freshIndex = makeIndex();
    freshIndex.builtAt = new Date(Date.now() - (25 * 60 * 60 * 1000 + 59 * 60 * 1000));
    vi.mocked(ensureIndex).mockResolvedValueOnce(freshIndex as never);

    const freshRes = await POST(
      makeRequest({ tutorGroupIds: ["g1"], mode: "recurring", weekStart: "2026-04-06" }),
    );
    const freshBody = await freshRes.json();

    const staleIndex = makeIndex();
    staleIndex.builtAt = new Date(Date.now() - (26 * 60 * 60 * 1000 + 1));
    vi.mocked(ensureIndex).mockResolvedValueOnce(staleIndex as never);

    const staleRes = await POST(
      makeRequest({ tutorGroupIds: ["g1"], mode: "recurring", weekStart: "2026-04-06" }),
    );
    const staleBody = await staleRes.json();

    expect(freshBody.snapshotMeta.stale).toBe(false);
    expect(freshBody.warnings).toEqual([]);
    expect(staleBody.snapshotMeta.stale).toBe(true);
    expect(staleBody.warnings).toContain(
      "Search data may be stale — last sync was more than 26 hours ago",
    );
  });

  it("returns 500 when ensureIndex throws", async () => {
    vi.mocked(ensureIndex).mockRejectedValue(new Error("DB exploded") as never);

    const res = await POST(makeRequest({ tutorGroupIds: ["g1"], mode: "recurring" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
  });
});
