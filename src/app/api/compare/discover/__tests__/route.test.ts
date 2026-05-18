import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";
import type { IndexedTutorGroup, SearchIndex } from "@/lib/search/index";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { POST } from "@/app/api/compare/discover/route";

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
    syncedAt: new Date("2026-04-06T00:00:00.000Z"),
    tutorGroups: groups,
    byWeekday: new Map([[1, groups]]),
  };
}

describe("POST /api/compare/discover", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } });
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(ensureIndex).mockResolvedValue(makeIndex() as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRequest(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/compare/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ existingTutorGroupIds: [], mode: "recurring" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 400 when body fails Zod validation", async () => {
    const res = await POST(
      makeRequest({ existingTutorGroupIds: ["g1", "g2", "g3"], mode: "recurring" }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
    expect(body.details).toBeDefined();
  });

  it("returns 200 with discovery response shape on success", async () => {
    const res = await POST(
      makeRequest({
        existingTutorGroupIds: [],
        mode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:30",
        modeFilter: "online",
        filters: { subject: "Math" },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      snapshotMeta: expect.objectContaining({ snapshotId: "snap-1", stale: expect.any(Boolean) }),
      candidates: [
        expect.objectContaining({
          tutorGroupId: "g1",
          displayName: "Test Tutor",
          conflictCount: 0,
          freeSlots: [{ start: "15:00", end: "16:30" }],
          hasDataIssues: false,
        }),
      ],
      latencyMs: expect.any(Number),
    });
  });

  it("marks snapshot metadata stale from the sync timestamp after the 90-minute API threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T02:00:00.000Z"));
    const freshIndex = makeIndex();
    freshIndex.builtAt = new Date("2026-04-01T00:00:00.000Z");
    freshIndex.syncedAt = new Date(Date.now() - 90 * 60 * 1000);
    vi.mocked(ensureIndex).mockResolvedValueOnce(freshIndex as never);

    const freshRes = await POST(
      makeRequest({
        existingTutorGroupIds: [],
        mode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:30",
      }),
    );
    const freshBody = await freshRes.json();

    const staleIndex = makeIndex();
    staleIndex.builtAt = new Date();
    staleIndex.syncedAt = new Date(Date.now() - (90 * 60 * 1000 + 1));
    vi.mocked(ensureIndex).mockResolvedValueOnce(staleIndex as never);

    const staleRes = await POST(
      makeRequest({
        existingTutorGroupIds: [],
        mode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:30",
      }),
    );
    const staleBody = await staleRes.json();

    expect(freshBody.snapshotMeta.syncedAt).toBe(freshIndex.syncedAt.toISOString());
    expect(freshBody.snapshotMeta.stale).toBe(false);
    expect(staleBody.snapshotMeta.syncedAt).toBe(staleIndex.syncedAt.toISOString());
    expect(staleBody.snapshotMeta.stale).toBe(true);
  });

  it("does not block one-time discovery for same-weekday sessions on different dates", async () => {
    const group = makeTutorGroup({
      sessionBlocks: [
        {
          startTime: new Date("2026-04-13T08:00:00.000Z"),
          endTime: new Date("2026-04-13T09:30:00.000Z"),
          weekday: 1,
          startMinute: 900,
          endMinute: 990,
          isBlocking: true,
          wiseTeacherId: "wise-1",
        },
      ],
    });
    vi.mocked(ensureIndex).mockResolvedValue(makeIndex([group]) as never);

    const res = await POST(
      makeRequest({
        existingTutorGroupIds: [],
        mode: "one_time",
        date: "2026-04-06",
        startTime: "15:00",
        endTime: "16:30",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0].freeSlots).toEqual([{ start: "15:00", end: "16:30" }]);

    const blockedRes = await POST(
      makeRequest({
        existingTutorGroupIds: [],
        mode: "one_time",
        date: "2026-04-13",
        startTime: "15:00",
        endTime: "16:30",
      }),
    );

    expect(blockedRes.status).toBe(200);
    const blockedBody = await blockedRes.json();
    expect(blockedBody.candidates[0].freeSlots).toEqual([]);
  });

  it("matches one-time session blocks by Bangkok calendar date", async () => {
    const group = makeTutorGroup({
      availabilityWindows: [
        { weekday: 1, startMinute: 0, endMinute: 120, modality: "online", wiseTeacherId: "wise-1" },
      ],
      sessionBlocks: [
        {
          startTime: new Date("2026-04-06T00:30:00.000Z"),
          endTime: new Date("2026-04-06T01:30:00.000Z"),
          weekday: 1,
          startMinute: 30,
          endMinute: 90,
          isBlocking: true,
          wiseTeacherId: "wise-1",
        },
      ],
    });
    vi.mocked(ensureIndex).mockResolvedValue(makeIndex([group]) as never);

    const res = await POST(
      makeRequest({
        existingTutorGroupIds: [],
        mode: "one_time",
        date: "2026-04-06",
        startTime: "00:00",
        endTime: "01:00",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0].freeSlots).toEqual([]);
  });

  it("requires availability window modality to match the requested mode", async () => {
    const group = makeTutorGroup({
      supportedModes: ["online", "onsite"],
      availabilityWindows: [
        { weekday: 1, startMinute: 900, endMinute: 1020, modality: "onsite", wiseTeacherId: "wise-1" },
      ],
    });
    vi.mocked(ensureIndex).mockResolvedValue(makeIndex([group]) as never);

    const res = await POST(
      makeRequest({
        existingTutorGroupIds: [],
        mode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:30",
        modeFilter: "online",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0].freeSlots).toEqual([]);
  });

  it("does not offer free slots that overlap leaves", async () => {
    const group = makeTutorGroup({
      leaves: [
        {
          startTime: new Date("2026-04-06T15:15:00.000Z"),
          endTime: new Date("2026-04-06T16:00:00.000Z"),
        },
      ],
    });
    vi.mocked(ensureIndex).mockResolvedValue(makeIndex([group]) as never);

    const res = await POST(
      makeRequest({
        existingTutorGroupIds: [],
        mode: "one_time",
        date: "2026-04-06",
        startTime: "15:00",
        endTime: "16:30",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0].freeSlots).toEqual([]);
  });

  it("returns 500 when ensureIndex throws", async () => {
    vi.mocked(ensureIndex).mockRejectedValue(new Error("DB exploded") as never);

    const res = await POST(makeRequest({ existingTutorGroupIds: [], mode: "recurring" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
  });
});
