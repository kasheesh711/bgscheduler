import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/auth` instantiates NextAuth at import time and `@/lib/db` pulls the
// Neon driver; stub both so the route can be unit-tested in isolation.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
// Keep the real requireAdmissionsSession + admissionsErrorResponse (driven via
// the auth mock); stub the two db-backed access checks.
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCaseAccess: vi.fn(),
  requireCounselorOrAdmin: vi.fn(),
}));
vi.mock("@/lib/admissions/announcements", () => ({
  createAnnouncement: vi.fn(),
  listAnnouncementsForCase: vi.fn(),
  listAnnouncementsForCohort: vi.fn(),
  softDeleteAnnouncement: vi.fn(),
  updateAnnouncement: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess, requireCounselorOrAdmin } from "@/lib/admissions/access";
import {
  createAnnouncement,
  listAnnouncementsForCase,
  listAnnouncementsForCohort,
  softDeleteAnnouncement,
  updateAnnouncement,
} from "@/lib/admissions/announcements";
import { DELETE, GET, PATCH, POST } from "../route";
import type { AdmissionsStaffAccess } from "@/lib/admissions/access";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const COHORT_ID = "22222222-2222-4222-8222-222222222222";
const ANNOUNCEMENT_ID = "33333333-3333-4333-8333-333333333333";

const COUNSELOR_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "counselor@example.com",
  role: "counselor",
  isAdmin: false,
};

const STUDENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "student@example.com",
  role: "student",
  isAdmin: false,
};

const COUNSELOR_STAFF: AdmissionsStaffAccess = {
  email: "counselor@example.com",
  role: "counselor",
  isAdmin: false,
};

const ADMIN_STAFF: AdmissionsStaffAccess = {
  email: "admin@example.com",
  role: "admin",
  isAdmin: true,
};

const CASE_ANNOUNCEMENT_DTO = {
  id: ANNOUNCEMENT_ID,
  cohortId: null,
  caseId: CASE_ID,
  title: "Essay workshop moved",
  body: "Now on Saturday 10:00.",
  authorEmail: "counselor@example.com",
  createdAt: "2026-07-01T03:00:00.000Z",
  updatedAt: "2026-07-01T03:00:00.000Z",
};

const COHORT_ANNOUNCEMENT_DTO = {
  ...CASE_ANNOUNCEMENT_DTO,
  cohortId: COHORT_ID,
  caseId: null,
};

function makeGetRequest(query: string) {
  return new NextRequest(`http://test.local/api/admissions/announcements${query}`);
}

function makeBodyRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest("http://test.local/api/admissions/announcements", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function makeDeleteRequest(query: string) {
  return new NextRequest(`http://test.local/api/admissions/announcements${query}`, {
    method: "DELETE",
  });
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/announcements", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("counselor@example.com", "counselor");
    vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);
    vi.mocked(requireCounselorOrAdmin).mockResolvedValue(COUNSELOR_STAFF);
    vi.mocked(listAnnouncementsForCase).mockResolvedValue([CASE_ANNOUNCEMENT_DTO]);
    vi.mocked(listAnnouncementsForCohort).mockResolvedValue([COHORT_ANNOUNCEMENT_DTO]);
    vi.mocked(createAnnouncement).mockResolvedValue(CASE_ANNOUNCEMENT_DTO);
    vi.mocked(updateAnnouncement).mockResolvedValue(CASE_ANNOUNCEMENT_DTO);
    vi.mocked(softDeleteAnnouncement).mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("lists case announcements for a student member (minRole student)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);

      const res = await GET(makeGetRequest(`?caseId=${CASE_ID}`));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        announcements: [CASE_ANNOUNCEMENT_DTO],
      });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(listAnnouncementsForCase).toHaveBeenCalledWith(CASE_ID);
      expect(requireCounselorOrAdmin).not.toHaveBeenCalled();
      expect(listAnnouncementsForCohort).not.toHaveBeenCalled();
    });

    it("lists cohort announcements through the staff gate only", async () => {
      const res = await GET(makeGetRequest(`?cohortId=${COHORT_ID}`));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        announcements: [COHORT_ANNOUNCEMENT_DTO],
      });
      expect(requireCounselorOrAdmin).toHaveBeenCalledWith("counselor@example.com");
      expect(listAnnouncementsForCohort).toHaveBeenCalledWith(COHORT_ID);
      expect(requireCaseAccess).not.toHaveBeenCalled();
    });

    it("returns 403 for a cohort-wide list when the caller is not staff", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(makeGetRequest(`?cohortId=${COHORT_ID}`));

      expect(res.status).toBe(403);
      expect(listAnnouncementsForCohort).not.toHaveBeenCalled();
    });

    it("returns 400 when both cohortId and caseId are given (scope XOR)", async () => {
      const res = await GET(makeGetRequest(`?cohortId=${COHORT_ID}&caseId=${CASE_ID}`));

      expect(res.status).toBe(400);
      expect(listAnnouncementsForCase).not.toHaveBeenCalled();
      expect(listAnnouncementsForCohort).not.toHaveBeenCalled();
    });

    it("returns 400 when neither scope is given (scope XOR)", async () => {
      const res = await GET(makeGetRequest(""));

      expect(res.status).toBe(400);
      expect(listAnnouncementsForCase).not.toHaveBeenCalled();
      expect(listAnnouncementsForCohort).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-uuid scope id", async () => {
      const res = await GET(makeGetRequest("?caseId=not-a-uuid"));

      expect(res.status).toBe(400);
      expect(requireCaseAccess).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(makeGetRequest(`?caseId=${CASE_ID}`));

      expect(res.status).toBe(401);
      expect(listAnnouncementsForCase).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller is not a member of the case", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(makeGetRequest(`?caseId=${CASE_ID}`));

      expect(res.status).toBe(403);
      expect(listAnnouncementsForCase).not.toHaveBeenCalled();
    });
  });

  describe("POST", () => {
    it("creates a case-scoped announcement behind requireCaseAccess minRole counselor", async () => {
      const res = await POST(
        makeBodyRequest("POST", {
          caseId: CASE_ID,
          title: "Essay workshop moved",
          body: "Now on Saturday 10:00.",
        }),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ announcement: CASE_ANNOUNCEMENT_DTO });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(createAnnouncement).toHaveBeenCalledWith({
        caseId: CASE_ID,
        title: "Essay workshop moved",
        body: "Now on Saturday 10:00.",
        authorEmail: "counselor@example.com",
        actorRole: "counselor",
      });
      expect(requireCounselorOrAdmin).not.toHaveBeenCalled();
    });

    it("creates a cohort broadcast behind the staff gate (admin allowed)", async () => {
      signInAs("admin@example.com", "admin");
      vi.mocked(requireCounselorOrAdmin).mockResolvedValue(ADMIN_STAFF);
      vi.mocked(createAnnouncement).mockResolvedValue(COHORT_ANNOUNCEMENT_DTO);

      const res = await POST(
        makeBodyRequest("POST", {
          cohortId: COHORT_ID,
          title: "Common App opens",
          body: "Accounts go live Aug 1.",
        }),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ announcement: COHORT_ANNOUNCEMENT_DTO });
      expect(requireCounselorOrAdmin).toHaveBeenCalledWith("admin@example.com");
      expect(createAnnouncement).toHaveBeenCalledWith({
        cohortId: COHORT_ID,
        title: "Common App opens",
        body: "Accounts go live Aug 1.",
        authorEmail: "admin@example.com",
        actorRole: "admin",
      });
      expect(requireCaseAccess).not.toHaveBeenCalled();
    });

    it("returns 400 when both scopes are given (scope XOR, nothing written)", async () => {
      const res = await POST(
        makeBodyRequest("POST", {
          cohortId: COHORT_ID,
          caseId: CASE_ID,
          title: "t",
          body: "b",
        }),
      );

      expect(res.status).toBe(400);
      expect(createAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 400 when neither scope is given (scope XOR, nothing written)", async () => {
      const res = await POST(makeBodyRequest("POST", { title: "t", body: "b" }));

      expect(res.status).toBe(400);
      expect(createAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 400 for an empty title or body", async () => {
      for (const body of [
        { caseId: CASE_ID, title: "   ", body: "b" },
        { caseId: CASE_ID, title: "t", body: "" },
      ]) {
        const res = await POST(makeBodyRequest("POST", body));
        expect(res.status).toBe(400);
      }
      expect(createAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeBodyRequest("POST"));

      expect(res.status).toBe(400);
      expect(createAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller is below counselor on the case", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(
        makeBodyRequest("POST", { caseId: CASE_ID, title: "t", body: "b" }),
      );

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(createAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 403 for a cohort broadcast when the caller is not staff", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(
        makeBodyRequest("POST", { cohortId: COHORT_ID, title: "t", body: "b" }),
      );

      expect(res.status).toBe(403);
      expect(createAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(
        makeBodyRequest("POST", { caseId: CASE_ID, title: "t", body: "b" }),
      );

      expect(res.status).toBe(401);
      expect(createAnnouncement).not.toHaveBeenCalled();
    });
  });

  describe("PATCH", () => {
    it("updates an announcement behind the staff gate", async () => {
      const res = await PATCH(
        makeBodyRequest("PATCH", { announcementId: ANNOUNCEMENT_ID, title: "New title" }),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ announcement: CASE_ANNOUNCEMENT_DTO });
      expect(requireCounselorOrAdmin).toHaveBeenCalledWith("counselor@example.com");
      expect(updateAnnouncement).toHaveBeenCalledWith({
        announcementId: ANNOUNCEMENT_ID,
        actorEmail: "counselor@example.com",
        actorRole: "counselor",
        title: "New title",
        body: undefined,
      });
    });

    it("returns 403 before reading the body when the caller is not staff", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeBodyRequest("PATCH", { announcementId: ANNOUNCEMENT_ID, title: "x" }),
      );

      expect(res.status).toBe(403);
      expect(updateAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 400 when announcementId is missing or not a uuid", async () => {
      for (const body of [{ title: "x" }, { announcementId: "not-a-uuid", title: "x" }]) {
        const res = await PATCH(makeBodyRequest("PATCH", body));
        expect(res.status).toBe(400);
      }
      expect(updateAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 400 when neither title nor body is provided", async () => {
      const res = await PATCH(makeBodyRequest("PATCH", { announcementId: ANNOUNCEMENT_ID }));

      expect(res.status).toBe(400);
      expect(updateAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await PATCH(makeBodyRequest("PATCH"));

      expect(res.status).toBe(400);
      expect(updateAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 404 when the announcement does not exist", async () => {
      vi.mocked(updateAnnouncement).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeBodyRequest("PATCH", { announcementId: ANNOUNCEMENT_ID, title: "x" }),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await PATCH(
        makeBodyRequest("PATCH", { announcementId: ANNOUNCEMENT_ID, title: "x" }),
      );

      expect(res.status).toBe(401);
      expect(updateAnnouncement).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("soft-deletes an announcement behind the staff gate", async () => {
      const res = await DELETE(makeDeleteRequest(`?announcementId=${ANNOUNCEMENT_ID}`));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(requireCounselorOrAdmin).toHaveBeenCalledWith("counselor@example.com");
      expect(softDeleteAnnouncement).toHaveBeenCalledWith({
        announcementId: ANNOUNCEMENT_ID,
        actorEmail: "counselor@example.com",
        actorRole: "counselor",
      });
    });

    it("returns 400 when announcementId is missing or not a uuid", async () => {
      for (const query of ["", "?announcementId=not-a-uuid"]) {
        const res = await DELETE(makeDeleteRequest(query));
        expect(res.status).toBe(400);
      }
      expect(softDeleteAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller is not staff", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await DELETE(makeDeleteRequest(`?announcementId=${ANNOUNCEMENT_ID}`));

      expect(res.status).toBe(403);
      expect(softDeleteAnnouncement).not.toHaveBeenCalled();
    });

    it("returns 404 when the announcement is missing or already deleted", async () => {
      vi.mocked(softDeleteAnnouncement).mockRejectedValue(new Error("NotFound"));

      const res = await DELETE(makeDeleteRequest(`?announcementId=${ANNOUNCEMENT_ID}`));

      expect(res.status).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await DELETE(makeDeleteRequest(`?announcementId=${ANNOUNCEMENT_ID}`));

      expect(res.status).toBe(401);
      expect(softDeleteAnnouncement).not.toHaveBeenCalled();
    });
  });
});
