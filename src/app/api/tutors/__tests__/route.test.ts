import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { TutorListItem } from "@/lib/data/tutors";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/data/tutors", () => ({ getTutorList: vi.fn() }));

import { auth } from "@/lib/auth";
import { getTutorList } from "@/lib/data/tutors";
import { GET } from "@/app/api/tutors/route";

const authMock = auth as unknown as Mock;

function makeTutorList(): TutorListItem[] {
  return [
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
  ];
}

describe("GET /api/tutors", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } });
    vi.mocked(getTutorList).mockResolvedValue(makeTutorList());
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

  it("returns 500 when tutor list loading throws", async () => {
    vi.mocked(getTutorList).mockRejectedValue(new Error("DB exploded"));

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
  });
});
