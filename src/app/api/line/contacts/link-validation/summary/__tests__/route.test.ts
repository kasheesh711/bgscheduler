import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/link-validation", () => ({
  getLineLinkValidationSummary: vi.fn(async () => ({
    canViewTracker: true,
    runId: "00000000-0000-4000-8000-000000000001",
    totals: {
      assigned: 1,
      unassigned: 0,
      verified: 2,
      rejected: 1,
      remaining: 1,
      total: 4,
      completionRate: 75,
    },
    reviewers: [],
    recentActivity: [],
  })),
}));

import { auth } from "@/lib/auth";
import { getLineLinkValidationSummary } from "@/lib/line/link-validation";
import { GET } from "@/app/api/line/contacts/link-validation/summary/route";

const authMock = auth as unknown as Mock;

function request(url = "http://test.local/api/line/contacts/link-validation/summary") {
  return new NextRequest(url);
}

describe("LINE link validation summary route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com", name: "Kevin" } });
    vi.mocked(getLineLinkValidationSummary).mockResolvedValue({
      canViewTracker: true,
      runId: "00000000-0000-4000-8000-000000000001",
      totals: {
        assigned: 1,
        unassigned: 0,
        verified: 2,
        rejected: 1,
        remaining: 1,
        total: 4,
        completionRate: 75,
      },
      reviewers: [],
      recentActivity: [],
    });
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(getLineLinkValidationSummary).not.toHaveBeenCalled();
  });

  it("returns tracker summary for the signed-in lead", async () => {
    const response = await GET(request(
      "http://test.local/api/line/contacts/link-validation/summary?runId=00000000-0000-4000-8000-000000000001",
    ));

    expect(response.status).toBe(200);
    expect(getLineLinkValidationSummary).toHaveBeenCalledWith({ db: true }, {
      runId: "00000000-0000-4000-8000-000000000001",
      actor: { email: "kevhsh7@gmail.com", name: "Kevin" },
    });
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        canViewTracker: true,
        totals: { completionRate: 75 },
      },
    });
  });

  it("passes through canViewTracker false for non-lead admins", async () => {
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(getLineLinkValidationSummary).mockResolvedValue({
      canViewTracker: false,
      runId: null,
      totals: {
        assigned: 0,
        unassigned: 0,
        verified: 0,
        rejected: 0,
        remaining: 0,
        total: 0,
        completionRate: 0,
      },
      reviewers: [],
      recentActivity: [],
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: { canViewTracker: false },
    });
  });

  it("rejects malformed run IDs", async () => {
    const response = await GET(request("http://test.local/api/line/contacts/link-validation/summary?runId=bad"));

    expect(response.status).toBe(400);
    expect(getLineLinkValidationSummary).not.toHaveBeenCalled();
  });
});
