import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/family-cases", () => ({ listLinkedFamilyCases: vi.fn() }));

import { auth } from "@/lib/auth";
import { listLinkedFamilyCases } from "@/lib/admissions/family-cases";
import { GET } from "../route";

const authMock = auth as unknown as Mock;

describe("GET /api/admissions/family-cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: {
        email: "parent@example.com",
        name: "Parent",
        role: "parent",
        allowedPages: ["/admissions"],
      },
    });
    vi.mocked(listLinkedFamilyCases).mockResolvedValue([
      {
        href: "/admissions/11111111-1111-4111-8111-111111111111",
        studentName: "Ada",
        preferredName: "Addie",
        cohortName: "Class of 2028",
        caseStatus: "active",
      },
    ]);
  });

  it("returns the linked cases for the signed-in parent", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cases: [expect.objectContaining({ studentName: "Ada" })],
    });
    expect(listLinkedFamilyCases).toHaveBeenCalledWith("parent@example.com");
  });

  it("denies non-parent roles", async () => {
    authMock.mockResolvedValue({
      user: {
        email: "student@example.com",
        name: "Student",
        role: "student",
        allowedPages: ["/admissions"],
      },
    });
    const response = await GET();
    expect(response.status).toBe(403);
    expect(listLinkedFamilyCases).not.toHaveBeenCalled();
  });

  it("denies unauthenticated requests", async () => {
    authMock.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
  });
});
