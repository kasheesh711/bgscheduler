import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { IndexedTutorGroup, SearchIndex } from "@/lib/search/index";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { GET } from "@/app/api/tutors/route";

const authMock = auth as unknown as Mock;

function makeTutorGroup(overrides: Partial<IndexedTutorGroup>): IndexedTutorGroup {
  return {
    id: "g1",
    canonicalKey: "test",
    displayName: "Test Tutor",
    supportedModes: ["online"],
    qualifications: [],
    wiseRecords: [],
    availabilityWindows: [],
    leaves: [],
    sessionBlocks: [],
    dataIssues: [],
    ...overrides,
  };
}

function makeIndex(): SearchIndex {
  const groups = [
    makeTutorGroup({
      id: "g2",
      displayName: "Zed Tutor",
      supportedModes: ["onsite"],
      qualifications: [{ subject: "Physics", curriculum: "IB", level: "Grade 11" }],
    }),
    makeTutorGroup({
      id: "g1",
      displayName: "Ada Tutor",
      supportedModes: ["online"],
      qualifications: [
        { subject: "Math", curriculum: "IB", level: "Grade 10" },
        { subject: "Math", curriculum: "AP", level: "Grade 11" },
      ],
    }),
  ];
  return {
    snapshotId: "snap-1",
    builtAt: new Date("2026-04-06T00:00:00.000Z"),
    tutorGroups: groups,
    byWeekday: new Map(),
  };
}

describe("GET /api/tutors", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } });
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(ensureIndex).mockResolvedValue(makeIndex() as never);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 200 with sorted tutor list on success", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      tutors: [
        {
          tutorGroupId: "g1",
          displayName: "Ada Tutor",
          supportedModes: ["online"],
          subjects: ["Math"],
        },
        {
          tutorGroupId: "g2",
          displayName: "Zed Tutor",
          supportedModes: ["onsite"],
          subjects: ["Physics"],
        },
      ],
    });
  });

  it("returns 500 when ensureIndex throws", async () => {
    vi.mocked(ensureIndex).mockRejectedValue(new Error("DB exploded") as never);

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
  });
});
