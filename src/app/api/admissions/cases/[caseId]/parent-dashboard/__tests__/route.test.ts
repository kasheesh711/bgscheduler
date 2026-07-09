import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/auth` instantiates NextAuth at import time and `@/lib/db` pulls the
// Neon driver; stub both so the route can be unit-tested in isolation.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
// Keep the real requireAdmissionsSession + admissionsErrorResponse (driven via
// the auth mock) so session gating and error→status mapping are exercised for
// real; only the db-backed per-case membership check is stubbed.
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCaseAccess: vi.fn(),
}));
// The projection is the unit under its own test suite; here it is a stub so
// the route test pins ONLY the transport contract (guard → builder → body).
vi.mock("@/lib/admissions/parent-projection", () => ({
  buildParentDashboard: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import { buildParentDashboard } from "@/lib/admissions/parent-projection";
import { GET } from "../route";
import type { ParentDashboard } from "@/lib/admissions/parent-projection";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";

const PARENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "parent@example.com",
  role: "parent",
  isAdmin: false,
};

const COUNSELOR_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "staff@example.com",
  role: "counselor",
  isAdmin: false,
};

const DASHBOARD: ParentDashboard = {
  studentName: "Nong Prae",
  cohortName: "Class of 2027",
  caseStatus: "active",
  progress: { done: 3, total: 10, percent: 30 },
  phaseProgress: [
    { phase: "essays", label: "Essays", done: 1, total: 4, percent: 25 },
  ],
  collegeList: [
    {
      instName: "Brown University",
      round: "ed",
      roundLabel: "Early Decision",
      appStatus: "applying",
      deadline: "2026-11-01",
      category: "reach",
    },
  ],
  upcomingDeadlines: [
    { source: "task", title: "Draft main essay", date: "2026-07-15", overdue: false },
  ],
  announcements: [
    { title: "Kickoff", body: "Welcome to the season!", createdAt: "2026-07-01T00:00:00.000Z" },
  ],
  testingMilestones: [
    { testType: "sat", testDate: "2026-08-22", registered: true, taken: false, scoreReceived: false },
  ],
  sharedNotes: [
    { body: "Great progress this week", createdAt: "2026-07-02T00:00:00.000Z" },
  ],
};

function makeCtx(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function makeRequest() {
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/parent-dashboard`,
  );
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/cases/[caseId]/parent-dashboard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("parent@example.com", "parent");
    vi.mocked(requireCaseAccess).mockResolvedValue(PARENT_ACCESS);
    vi.mocked(buildParentDashboard).mockResolvedValue(DASHBOARD);
  });

  describe("GET", () => {
    it("returns the projection for a parent member with minRole parent", async () => {
      const res = await GET(makeRequest(), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ dashboard: DASHBOARD });
      expect(requireCaseAccess).toHaveBeenCalledWith(
        "parent@example.com",
        CASE_ID,
        "parent",
      );
      expect(buildParentDashboard).toHaveBeenCalledWith(CASE_ID);
    });

    it("serves ONLY the projection — no other top-level keys", async () => {
      const res = await GET(makeRequest(), makeCtx());

      expect(Object.keys(await res.json())).toEqual(["dashboard"]);
    });

    it("lets staff preview the exact family view (counselor membership)", async () => {
      signInAs("staff@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);

      const res = await GET(makeRequest(), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ dashboard: DASHBOARD });
      expect(requireCaseAccess).toHaveBeenCalledWith(
        "staff@example.com",
        CASE_ID,
        "parent",
      );
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(makeRequest(), makeCtx());

      expect(res.status).toBe(401);
      expect(requireCaseAccess).not.toHaveBeenCalled();
      expect(buildParentDashboard).not.toHaveBeenCalled();
    });

    it("returns 403 when the session lacks /admissions page access", async () => {
      authMock.mockResolvedValue({
        user: { email: "other@example.com", name: "Other", allowedPages: ["/credit-control"] },
      });

      const res = await GET(makeRequest(), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).not.toHaveBeenCalled();
      expect(buildParentDashboard).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-member without building the projection", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(makeRequest(), makeCtx());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
      expect(buildParentDashboard).not.toHaveBeenCalled();
    });

    it("returns 404 for an admin when the case does not exist", async () => {
      signInAs("admin@example.com", "admin");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("NotFound"));

      const res = await GET(makeRequest(), makeCtx());

      expect(res.status).toBe(404);
      expect(buildParentDashboard).not.toHaveBeenCalled();
    });

    it("maps a builder NotFound (case vanished mid-request) to 404", async () => {
      vi.mocked(buildParentDashboard).mockRejectedValue(new Error("NotFound"));

      const res = await GET(makeRequest(), makeCtx());

      expect(res.status).toBe(404);
    });

    it("returns 500 JSON when the builder throws", async () => {
      vi.mocked(buildParentDashboard).mockRejectedValue(new Error("DB exploded"));

      const res = await GET(makeRequest(), makeCtx());

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
    });
  });
});
