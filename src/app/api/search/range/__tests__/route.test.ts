import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";
import type { IndexedTutorGroup, SearchIndex } from "@/lib/search/index";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
vi.mock("@/lib/search/engine", () => ({
  executeSearch: vi.fn(),
  getBlockingSessions: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/proposals/data", () => ({
  listActiveProposalHolds: vi.fn().mockResolvedValue([]),
}));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listActiveProposalHolds } from "@/lib/proposals/data";
import { ensureIndex } from "@/lib/search/index";
import { executeSearch } from "@/lib/search/engine";
import { POST } from "@/app/api/search/range/route";

const authMock = auth as unknown as Mock;

function makeTutorGroup(): IndexedTutorGroup {
  return {
    id: "g1",
    canonicalKey: "test",
    displayName: "Test Tutor",
    supportedModes: ["online"],
    qualifications: [{ subject: "Math", curriculum: "IB", level: "Grade 10" }],
    wiseRecords: [],
    availabilityWindows: [],
    leaves: [],
    sessionBlocks: [],
    dataIssues: [],
  };
}

function makeIndex(): SearchIndex {
  const group = makeTutorGroup();
  return {
    snapshotId: "snap-1",
    builtAt: new Date("2026-04-06T00:00:00.000Z"),
    tutorGroups: [group],
    byWeekday: new Map([[1, [group]]]),
  };
}

const rangeEngineResponse = {
  snapshotMeta: { snapshotId: "snap-1", syncedAt: "2026-04-06T00:00:00.000Z", stale: false },
  normalizedSlots: [],
  perSlotResults: [
    {
      slotId: "range-0",
      available: [
        {
          tutorGroupId: "g1",
          tutorCanonicalKey: "test",
          displayName: "Test Tutor",
          supportedModes: ["online"],
          qualifications: [{ subject: "Math", curriculum: "IB", level: "Grade 10" }],
          underlyingWiseRecords: [],
        },
      ],
      needsReview: [],
    },
    {
      slotId: "range-1",
      available: [
        {
          tutorGroupId: "g1",
          tutorCanonicalKey: "test",
          displayName: "Test Tutor",
          supportedModes: ["online"],
          qualifications: [{ subject: "Math", curriculum: "IB", level: "Grade 10" }],
          underlyingWiseRecords: [],
        },
      ],
      needsReview: [],
    },
  ],
  intersection: [],
  latencyMs: 9,
  warnings: [],
};

describe("POST /api/search/range", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } });
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(ensureIndex).mockResolvedValue(makeIndex() as never);
    vi.mocked(listActiveProposalHolds).mockResolvedValue([] as never);
    vi.mocked(executeSearch).mockReturnValue(rangeEngineResponse as never);
  });

  function makeRequest(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/search/range", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function validBody() {
    return {
      searchMode: "recurring",
      dayOfWeek: 1,
      startTime: "15:00",
      endTime: "18:00",
      durationMinutes: 90,
      mode: "online",
    };
  }

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 400 when body fails Zod validation", async () => {
    const res = await POST(makeRequest({ ...validBody(), startTime: "3pm" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
    expect(body.details).toBeDefined();
  });

  it("returns 400 when the time range is shorter than the class duration", async () => {
    const res = await POST(makeRequest({ ...validBody(), endTime: "16:00" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Time range is too short for the selected class duration",
    });
  });

  it("returns 200 with range response shape on success", async () => {
    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      snapshotMeta: { snapshotId: "snap-1", syncedAt: expect.any(String), stale: false },
      subSlots: [
        { start: "15:00", end: "16:30" },
        { start: "16:30", end: "18:00" },
      ],
      grid: [
        expect.objectContaining({
          tutorGroupId: "g1",
          displayName: "Test Tutor",
          availability: [true, true],
        }),
      ],
      needsReview: [],
      latencyMs: expect.any(Number),
      warnings: [],
    });
  });

  it("marks active proposal holds as blocked cells", async () => {
    vi.mocked(listActiveProposalHolds).mockResolvedValue([
      {
        itemId: "hold-1",
        bundleId: "bundle-1",
        studentLabel: "Beam",
        tutorCanonicalKey: "test",
        tutorDisplayName: "Test Tutor",
        scope: "recurring",
        weekday: 1,
        startMinute: 900,
        endMinute: 990,
        startTime: "15:00",
        endTime: "16:30",
        status: "pending",
        createdAt: "2026-05-15T00:00:00.000Z",
        expiresAt: "2026-05-17T00:00:00.000Z",
      },
    ] as never);

    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grid[0].availability[0]).toEqual([
      expect.objectContaining({
        kind: "proposal_hold",
        proposalHold: expect.objectContaining({ itemId: "hold-1" }),
      }),
    ]);
    expect(body.grid[0].availability[1]).toBe(true);
  });

  it("returns 500 when ensureIndex throws", async () => {
    vi.mocked(ensureIndex).mockRejectedValue(new Error("DB exploded") as never);

    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
  });
});
