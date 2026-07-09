import { describe, expect, beforeEach, it, vi } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/db` pulls the Neon driver and `@/lib/auth` executes NextAuth at
// import time; stub both. The access module is partially mocked so the real
// admissionsErrorResponse mapping (401/403/404/409/500) stays under test.
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admissions/access")>();
  return { ...actual, requireAdmissionsSession: vi.fn(), requireCaseAccess: vi.fn() };
});
vi.mock("@/lib/admissions/cases", () => ({
  getCaseDetail: vi.fn(),
  updateCaseLifecycle: vi.fn(),
  updateCaseProfile: vi.fn(),
}));

import { requireAdmissionsSession, requireCaseAccess } from "@/lib/admissions/access";
import {
  getCaseDetail,
  updateCaseLifecycle,
  updateCaseProfile,
} from "@/lib/admissions/cases";
import { GET, PATCH } from "@/app/api/admissions/cases/[caseId]/route";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-07-08T00:00:00.000Z";

const COUNSELOR = { email: "staff@example.com", name: "Staff", role: "counselor" as const };

const DETAIL = {
  caseId: CASE_ID,
  status: "active",
  statusChangedAt: "2026-06-01T00:00:00.000Z",
  committedListItemId: null,
  committedCollegeName: null,
  driveFolder: null,
  student: {
    id: "55555555-5555-4555-8555-555555555555",
    fullName: "Ada Lovelace",
    preferredName: null,
    studentEmail: "ada@example.com",
    phone: null,
    school: null,
    schoolCounselor: null,
    wiseStudentKey: null,
    externalLinks: {},
  },
  cohort: {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Class of 2027",
    graduationYear: 2027,
  },
  members: [],
  progressPercent: 0,
  nextDeadline: null,
  lastMeetingDate: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: UPDATED_AT,
};

function caseAccess(role: "parent" | "student" | "counselor" | "admin") {
  return {
    caseId: CASE_ID,
    email: role === "admin" ? "admin@example.com" : "staff@example.com",
    role,
    isAdmin: role === "admin",
  };
}

function routeContext(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function patchRequest(body?: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const getRequest = new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}`);

describe("/api/admissions/cases/[caseId]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireAdmissionsSession).mockResolvedValue(COUNSELOR);
    vi.mocked(requireCaseAccess).mockResolvedValue(caseAccess("counselor"));
    vi.mocked(getCaseDetail).mockResolvedValue(DETAIL as never);
    vi.mocked(updateCaseLifecycle).mockResolvedValue({
      caseId: CASE_ID,
      previousStatus: "active",
      status: "committed",
      statusChangedAt: "2026-07-09T00:00:00.000Z",
    } as never);
    vi.mocked(updateCaseProfile).mockResolvedValue({
      caseId: CASE_ID,
      updatedAt: "2026-07-09T00:00:00.000Z",
    } as never);
  });

  describe("GET", () => {
    it("returns the case detail for a counselor member", async () => {
      const res = await GET(getRequest, routeContext());

      expect(res.status).toBe(200);
      expect(requireCaseAccess).toHaveBeenCalledWith("staff@example.com", CASE_ID, "parent");
      await expect(res.json()).resolves.toEqual({ case: DETAIL });
    });

    it("returns the case detail for a student member", async () => {
      vi.mocked(requireCaseAccess).mockResolvedValue(caseAccess("student"));

      const res = await GET(getRequest, routeContext());

      expect(res.status).toBe(200);
    });

    it("returns 403 pointing parents at their dashboard", async () => {
      vi.mocked(requireCaseAccess).mockResolvedValue(caseAccess("parent"));

      const res = await GET(getRequest, routeContext());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Use parent dashboard" });
      expect(getCaseDetail).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      vi.mocked(requireAdmissionsSession).mockRejectedValue(new Error("Unauthorized"));

      const res = await GET(getRequest, routeContext());

      expect(res.status).toBe(401);
      expect(getCaseDetail).not.toHaveBeenCalled();
    });

    it("returns 403 when the viewer is not a member of this case", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(getRequest, routeContext());

      expect(res.status).toBe(403);
      expect(getCaseDetail).not.toHaveBeenCalled();
    });

    it("returns 404 when an admin requests a missing case", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("NotFound"));

      const res = await GET(getRequest, routeContext());

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH", () => {
    it("applies a lifecycle transition and returns the refreshed detail", async () => {
      const res = await PATCH(patchRequest({ status: "committed" }), routeContext());

      expect(res.status).toBe(200);
      expect(requireCaseAccess).toHaveBeenCalledWith("staff@example.com", CASE_ID, "counselor");
      expect(updateCaseLifecycle).toHaveBeenCalledWith(CASE_ID, "committed", {
        email: "staff@example.com",
        role: "counselor",
      });
      expect(updateCaseProfile).not.toHaveBeenCalled();
      await expect(res.json()).resolves.toEqual({ case: DETAIL });
    });

    it("applies profile field updates without a lifecycle write", async () => {
      const res = await PATCH(
        patchRequest({ driveFolder: "https://drive.example.com/x", student: { preferredName: "Ada" } }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(updateCaseProfile).toHaveBeenCalledWith({
        caseId: CASE_ID,
        actor: { email: "staff@example.com", role: "counselor" },
        expectedUpdatedAt: undefined,
        driveFolder: "https://drive.example.com/x",
        student: { preferredName: "Ada" },
      });
      expect(updateCaseLifecycle).not.toHaveBeenCalled();
    });

    it("applies profile updates before the lifecycle transition when both are sent", async () => {
      const res = await PATCH(
        patchRequest({ status: "committed", driveFolder: "https://drive.example.com/x" }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(updateCaseProfile).toHaveBeenCalledTimes(1);
      expect(updateCaseLifecycle).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updateCaseProfile).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(updateCaseLifecycle).mock.invocationCallOrder[0],
      );
    });

    it("returns 409 with both versions on a stale expectedUpdatedAt", async () => {
      const stale = "2026-07-01T00:00:00.000Z";

      const res = await PATCH(
        patchRequest({ status: "committed", expectedUpdatedAt: stale }),
        routeContext(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: "Conflict",
        expectedUpdatedAt: stale,
        currentUpdatedAt: UPDATED_AT,
      });
      expect(updateCaseLifecycle).not.toHaveBeenCalled();
      expect(updateCaseProfile).not.toHaveBeenCalled();
    });

    it("proceeds when expectedUpdatedAt matches the current version", async () => {
      const res = await PATCH(
        patchRequest({ status: "committed", expectedUpdatedAt: UPDATED_AT }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(updateCaseLifecycle).toHaveBeenCalled();
    });

    it("returns 400 when no updates are provided", async () => {
      const res = await PATCH(patchRequest({}), routeContext());

      expect(res.status).toBe(400);
      expect(updateCaseLifecycle).not.toHaveBeenCalled();
      expect(updateCaseProfile).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown status value", async () => {
      const res = await PATCH(patchRequest({ status: "paused" }), routeContext());

      expect(res.status).toBe(400);
    });

    it("returns 400 for an unparseable JSON body", async () => {
      const res = await PATCH(patchRequest(), routeContext());

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
    });

    it("returns 401 when unauthenticated", async () => {
      vi.mocked(requireAdmissionsSession).mockRejectedValue(new Error("Unauthorized"));

      const res = await PATCH(patchRequest({ status: "committed" }), routeContext());

      expect(res.status).toBe(401);
    });

    it("returns 403 when the member is below counselor (student/parent writes)", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(patchRequest({ status: "committed" }), routeContext());

      expect(res.status).toBe(403);
      expect(updateCaseLifecycle).not.toHaveBeenCalled();
    });

    it("returns 409 when the lifecycle transition is invalid", async () => {
      vi.mocked(updateCaseLifecycle).mockRejectedValue(new Error("Conflict"));

      const res = await PATCH(patchRequest({ status: "archived" }), routeContext());

      expect(res.status).toBe(409);
    });

    it("returns 404 when the case disappears before the update", async () => {
      vi.mocked(getCaseDetail).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(patchRequest({ status: "committed" }), routeContext());

      expect(res.status).toBe(404);
    });
  });
});
