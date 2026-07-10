import { describe, expect, beforeEach, it, vi } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/db` pulls the Neon driver and `@/lib/auth` executes NextAuth at
// import time; stub both. The access module is partially mocked so the real
// admissionsErrorResponse mapping (401/403/404/409/500) stays under test
// while the session guard is driven directly.
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admissions/access")>();
  return {
    ...actual,
    requireAdmissionsSession: vi.fn(),
    requireCaseAccess: vi.fn(),
    requireCounselorOrAdmin: vi.fn(),
  };
});
vi.mock("@/lib/admissions/cases", () => ({
  createCase: vi.fn(),
  getCaseloadForUser: vi.fn(),
}));

import { requireAdmissionsSession, requireCounselorOrAdmin } from "@/lib/admissions/access";
import { createCase, getCaseloadForUser } from "@/lib/admissions/cases";
import { GET, POST } from "@/app/api/admissions/cases/route";

const COHORT_ID = "44444444-4444-4444-8444-444444444444";

const COUNSELOR = { email: "staff@example.com", name: "Staff", role: "counselor" as const };
const ADMIN = { email: "admin@example.com", name: "Admin", role: "admin" as const };
const STUDENT = { email: "ada@example.com", name: "Ada", role: "student" as const };
const PARENT = { email: "mom@example.com", name: "Mom", role: "parent" as const };

const COUNSELOR_STAFF = { email: "staff@example.com", role: "counselor" as const, isAdmin: false };
const ADMIN_STAFF = { email: "admin@example.com", role: "admin" as const, isAdmin: true };

const SUMMARY = {
  caseId: "11111111-1111-4111-8111-111111111111",
  studentId: "55555555-5555-4555-8555-555555555555",
  studentName: "Ada Lovelace",
  preferredName: null,
  cohortId: COHORT_ID,
  cohortName: "Class of 2027",
  graduationYear: 2027,
  status: "active",
  counselorEmails: ["staff@example.com"],
  counselorNames: ["Staff"],
  progressPercent: 0,
  nextDeadline: null,
  daysSinceLastTouch: null,
  committedCollegeName: null,
  updatedAt: "2026-07-08T00:00:00.000Z",
};

const CREATE_BODY = {
  student: { fullName: "Ada Lovelace", studentEmail: "ada@example.com" },
  cohortId: COHORT_ID,
  parentEmails: ["mom@example.com"],
  counselorEmails: ["staff@example.com"],
};

function postRequest(body?: unknown) {
  return new NextRequest("http://test.local/api/admissions/cases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("/api/admissions/cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireAdmissionsSession).mockResolvedValue(COUNSELOR);
    vi.mocked(requireCounselorOrAdmin).mockResolvedValue(COUNSELOR_STAFF);
    vi.mocked(getCaseloadForUser).mockResolvedValue([SUMMARY] as never);
    vi.mocked(createCase).mockResolvedValue({
      caseId: SUMMARY.caseId,
      studentId: SUMMARY.studentId,
      members: [],
    } as never);
  });

  describe("GET", () => {
    it("returns the caseload for a counselor", async () => {
      const res = await GET();

      expect(res.status).toBe(200);
      // Staff rights re-resolved from Postgres (design §2.2), not the JWT.
      expect(requireCounselorOrAdmin).toHaveBeenCalledWith("staff@example.com");
      expect(getCaseloadForUser).toHaveBeenCalledWith("staff@example.com");
      await expect(res.json()).resolves.toEqual({ cases: [SUMMARY] });
    });

    it("returns the caseload for an admin", async () => {
      vi.mocked(requireAdmissionsSession).mockResolvedValue(ADMIN);
      vi.mocked(requireCounselorOrAdmin).mockResolvedValue(ADMIN_STAFF);

      const res = await GET();

      expect(res.status).toBe(200);
      expect(getCaseloadForUser).toHaveBeenCalledWith("admin@example.com");
    });

    it("returns 403 for a student session", async () => {
      vi.mocked(requireAdmissionsSession).mockResolvedValue(STUDENT);
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await GET();

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
      expect(getCaseloadForUser).not.toHaveBeenCalled();
    });

    it("returns 403 for a parent session", async () => {
      vi.mocked(requireAdmissionsSession).mockResolvedValue(PARENT);
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await GET();

      expect(res.status).toBe(403);
      expect(getCaseloadForUser).not.toHaveBeenCalled();
    });

    it("returns 403 for a deactivated counselor despite a staff JWT (instant revocation)", async () => {
      // JWT still says counselor, but the Postgres re-check denies.
      vi.mocked(requireAdmissionsSession).mockResolvedValue(COUNSELOR);
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await GET();

      expect(res.status).toBe(403);
      expect(getCaseloadForUser).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      vi.mocked(requireAdmissionsSession).mockRejectedValue(new Error("Unauthorized"));

      const res = await GET();

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    });

    it("returns 500 JSON when the caseload query throws", async () => {
      vi.mocked(getCaseloadForUser).mockRejectedValue(new Error("DB exploded"));

      const res = await GET();

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "Caseload load failed" });
    });
  });

  describe("POST", () => {
    it("creates a case as a counselor with a normalized payload", async () => {
      const res = await POST(postRequest(CREATE_BODY));

      expect(res.status).toBe(200);
      expect(createCase).toHaveBeenCalledWith({
        student: {
          fullName: "Ada Lovelace",
          preferredName: null,
          studentEmail: "ada@example.com",
          phone: null,
          school: null,
          schoolCounselor: null,
          wiseStudentKey: null,
        },
        cohortId: COHORT_ID,
        parentEmails: ["mom@example.com"],
        counselorEmails: ["staff@example.com"],
        createdBy: { email: "staff@example.com", role: "counselor" },
      });
      await expect(res.json()).resolves.toMatchObject({ caseId: SUMMARY.caseId });
    });

    it("defaults parentEmails to an empty list", async () => {
      const body = {
        student: CREATE_BODY.student,
        cohortId: CREATE_BODY.cohortId,
        counselorEmails: CREATE_BODY.counselorEmails,
      };

      const res = await POST(postRequest(body));

      expect(res.status).toBe(200);
      expect(createCase).toHaveBeenCalledWith(
        expect.objectContaining({ parentEmails: [] }),
      );
    });

    it("returns 401 when unauthenticated", async () => {
      vi.mocked(requireAdmissionsSession).mockRejectedValue(new Error("Unauthorized"));

      const res = await POST(postRequest(CREATE_BODY));

      expect(res.status).toBe(401);
      expect(createCase).not.toHaveBeenCalled();
    });

    it("returns 403 for a student session", async () => {
      vi.mocked(requireAdmissionsSession).mockResolvedValue(STUDENT);
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(postRequest(CREATE_BODY));

      expect(res.status).toBe(403);
      expect(createCase).not.toHaveBeenCalled();
    });

    it("returns 403 for a deactivated counselor despite a staff JWT (instant revocation)", async () => {
      vi.mocked(requireAdmissionsSession).mockResolvedValue(COUNSELOR);
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(postRequest(CREATE_BODY));

      expect(res.status).toBe(403);
      expect(createCase).not.toHaveBeenCalled();
    });

    it("returns 400 for an unparseable JSON body", async () => {
      const res = await POST(postRequest());

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
      expect(createCase).not.toHaveBeenCalled();
    });

    it("returns 400 when counselorEmails is empty", async () => {
      const res = await POST(postRequest({ ...CREATE_BODY, counselorEmails: [] }));

      expect(res.status).toBe(400);
      expect(createCase).not.toHaveBeenCalled();
    });

    it("returns 400 when a parent email equals the student email", async () => {
      const res = await POST(postRequest({ ...CREATE_BODY, parentEmails: ["ADA@example.com"] }));

      expect(res.status).toBe(400);
      expect(createCase).not.toHaveBeenCalled();
    });

    it("returns 409 when createCase reports a Conflict", async () => {
      vi.mocked(createCase).mockRejectedValue(new Error("Conflict"));

      const res = await POST(postRequest(CREATE_BODY));

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });
  });
});
