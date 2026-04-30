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

  it("returns 500 when ensureIndex throws", async () => {
    vi.mocked(ensureIndex).mockRejectedValue(new Error("DB exploded") as never);

    const res = await POST(makeRequest({ tutorGroupIds: ["g1"], mode: "recurring" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
  });
});
