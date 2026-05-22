import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";
import type { SearchIndex } from "@/lib/search/index";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
vi.mock("@/lib/search/engine", () => ({ executeSearch: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { executeSearch } from "@/lib/search/engine";
import { POST } from "@/app/api/search/route";

const authMock = auth as unknown as Mock;

const searchResponse = {
  snapshotMeta: { snapshotId: "snap-1", syncedAt: "2026-04-06T00:00:00.000Z", stale: false },
  normalizedSlots: [
    { id: "slot-1", dayOfWeek: 1, start: "15:00", end: "16:30", mode: "online" },
  ],
  perSlotResults: [
    {
      slotId: "slot-1",
      available: [
        {
          tutorGroupId: "g1",
          displayName: "Test Tutor",
          supportedModes: ["online"],
          qualifications: [{ subject: "Math", curriculum: "IB", level: "Grade 10" }],
          underlyingWiseRecords: [],
        },
      ],
      needsReview: [],
    },
  ],
  intersection: [
    {
      tutorGroupId: "g1",
      displayName: "Test Tutor",
      supportedModes: ["online"],
      qualifications: [{ subject: "Math", curriculum: "IB", level: "Grade 10" }],
      underlyingWiseRecords: [],
    },
  ],
  latencyMs: 7,
  warnings: [],
};

describe("POST /api/search", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } });
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(ensureIndex).mockResolvedValue({
      snapshotId: "snap-1",
      profileVersion: "0:",
      builtAt: new Date("2026-04-06T00:00:00.000Z"),
      syncedAt: new Date("2026-04-06T00:00:00.000Z"),
      tutorGroups: [],
      byWeekday: new Map(),
    } satisfies SearchIndex as never);
    vi.mocked(executeSearch).mockReturnValue(searchResponse as never);
  });

  function makeRequest(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function validBody() {
    return {
      searchMode: "recurring",
      slots: [{ id: "slot-1", dayOfWeek: 1, start: "15:00", end: "16:30", mode: "online" }],
    };
  }

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 400 when body fails Zod validation", async () => {
    const res = await POST(makeRequest({ searchMode: "recurring", slots: [] }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
    expect(body.details).toBeDefined();
  });

  it("returns 200 with search response shape on success", async () => {
    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      snapshotMeta: { snapshotId: "snap-1", syncedAt: expect.any(String), stale: false },
      normalizedSlots: [expect.objectContaining({ id: "slot-1" })],
      perSlotResults: [expect.objectContaining({ slotId: "slot-1" })],
      intersection: [expect.objectContaining({ tutorGroupId: "g1" })],
      latencyMs: expect.any(Number),
      warnings: [],
    });
  });

  it("returns 500 when ensureIndex throws", async () => {
    vi.mocked(ensureIndex).mockRejectedValue(new Error("DB exploded") as never);

    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
  });
});
