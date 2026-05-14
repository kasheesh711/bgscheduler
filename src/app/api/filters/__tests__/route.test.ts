import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { FilterOptions } from "@/lib/data/filters";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/data/filters", () => ({ getFilterOptions: vi.fn() }));

import { auth } from "@/lib/auth";
import { getFilterOptions } from "@/lib/data/filters";
import { GET } from "@/app/api/filters/route";

const authMock = auth as unknown as Mock;

function makeFilterOptions(): FilterOptions {
  return {
    subjects: ["Biology", "Math", "Physics"],
    curriculums: ["AP", "IB"],
    levels: ["Grade 10", "Grade 11"],
  };
}

describe("GET /api/filters", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } });
    vi.mocked(getFilterOptions).mockResolvedValue(makeFilterOptions());
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 200 with sorted filter values on success", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      subjects: ["Biology", "Math", "Physics"],
      curriculums: ["AP", "IB"],
      levels: ["Grade 10", "Grade 11"],
    });
  });

  it("returns 500 when filter loading throws", async () => {
    vi.mocked(getFilterOptions).mockRejectedValue(new Error("DB exploded"));

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
  });
});
