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
// Keep the real (pure) getSectionDefinition so the route's unknown-sectionKey
// 404 gate is exercised for real; stub only the db-backed functions.
vi.mock("@/lib/admissions/sections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/sections")>()),
  getSectionState: vi.fn(),
  reviewSection: vi.fn(),
  saveSectionDraft: vi.fn(),
  submitSection: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  getSectionDefinition,
  getSectionState,
  reviewSection,
  saveSectionDraft,
  submitSection,
} from "@/lib/admissions/sections";
import { GET, POST, PUT } from "../route";
import type { AdmissionsSectionStateDto } from "@/lib/admissions/sections";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const SECTION_KEY = "about_you";

const STUDENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "student@example.com",
  role: "student",
  isAdmin: false,
};

const COUNSELOR_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "counselor@example.com",
  role: "counselor",
  isAdmin: false,
};

const ADMIN_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "admin@example.com",
  role: "admin",
  isAdmin: true,
};

// Real definition (getSectionDefinition is kept un-mocked above).
const ABOUT_YOU_DEFINITION = getSectionDefinition(SECTION_KEY)!;

const SECTION_DTO: AdmissionsSectionStateDto = {
  caseId: CASE_ID,
  sectionKey: "about_you",
  definition: ABOUT_YOU_DEFINITION,
  payload: { preferred_name: "Mint" },
  state: "draft",
  submittedAt: null,
  reviewedByEmail: null,
  updatedAt: "2026-07-01T03:00:00.000Z",
};

function makeCtx(caseId: string = CASE_ID, sectionKey: string = SECTION_KEY) {
  return { params: Promise.resolve({ caseId, sectionKey }) };
}

function makeRequest(method: "PUT" | "POST", body?: unknown) {
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/sections/${SECTION_KEY}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/cases/[caseId]/sections/[sectionKey]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("student@example.com", "student");
    vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);
    vi.mocked(getSectionState).mockResolvedValue(SECTION_DTO);
    vi.mocked(saveSectionDraft).mockResolvedValue(SECTION_DTO);
    vi.mocked(submitSection).mockResolvedValue({
      section: { ...SECTION_DTO, state: "submitted" },
      notify: true,
    });
    vi.mocked(reviewSection).mockResolvedValue({ ...SECTION_DTO, state: "reviewed" });
  });

  describe("GET", () => {
    it("returns the section state with minRole student", async () => {
      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        section: JSON.parse(JSON.stringify(SECTION_DTO)),
      });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(getSectionState).toHaveBeenCalledWith(CASE_ID, SECTION_KEY);
    });

    it("returns 404 for an unknown sectionKey", async () => {
      const res = await GET(new Request("http://test.local"), makeCtx(CASE_ID, "not_a_section"));

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
      expect(getSectionState).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(401);
      expect(getSectionState).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-member BEFORE the sectionKey check (no key leak)", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx(CASE_ID, "not_a_section"));

      expect(res.status).toBe(403);
      expect(getSectionState).not.toHaveBeenCalled();
    });
  });

  describe("PUT", () => {
    it("autosaves a partial payload as the student", async () => {
      const res = await PUT(
        makeRequest("PUT", { payload: { preferred_name: "Mint", hometown: "Bangkok" } }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        section: JSON.parse(JSON.stringify(SECTION_DTO)),
      });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(saveSectionDraft).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        sectionKey: SECTION_KEY,
        payload: { preferred_name: "Mint", hometown: "Bangkok" },
      });
    });

    it("lets a counselor save on the student's behalf (attributed override)", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);

      const res = await PUT(
        makeRequest("PUT", { payload: { preferred_name: "Mint" } }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(saveSectionDraft).toHaveBeenCalledWith(
        expect.objectContaining({ access: COUNSELOR_ACCESS }),
      );
    });

    it("returns 404 for an unknown sectionKey, nothing written", async () => {
      const res = await PUT(
        makeRequest("PUT", { payload: { preferred_name: "Mint" } }),
        makeCtx(CASE_ID, "not_a_section"),
      );

      expect(res.status).toBe(404);
      expect(saveSectionDraft).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await PUT(makeRequest("PUT"), makeCtx());

      expect(res.status).toBe(400);
      expect(saveSectionDraft).not.toHaveBeenCalled();
    });

    it("returns 400 when payload is not an object", async () => {
      const res = await PUT(makeRequest("PUT", { payload: "oops" }), makeCtx());

      expect(res.status).toBe(400);
      expect(saveSectionDraft).not.toHaveBeenCalled();
    });

    it("returns 403 for a parent, nothing written", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await PUT(
        makeRequest("PUT", { payload: { preferred_name: "Mint" } }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(saveSectionDraft).not.toHaveBeenCalled();
    });
  });

  describe("POST action=submit", () => {
    it("submits as the student and returns the notify marker", async () => {
      const res = await POST(makeRequest("POST", { action: "submit" }), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        section: JSON.parse(JSON.stringify({ ...SECTION_DTO, state: "submitted" })),
        notify: true,
      });
      expect(submitSection).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        sectionKey: SECTION_KEY,
      });
      expect(reviewSection).not.toHaveBeenCalled();
    });

    it("lets a counselor submit on the student's behalf (attributed)", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);

      const res = await POST(makeRequest("POST", { action: "submit" }), makeCtx());

      expect(res.status).toBe(200);
      expect(submitSection).toHaveBeenCalledWith(
        expect.objectContaining({ access: COUNSELOR_ACCESS }),
      );
    });

    it("returns 409 when the section is not a submittable draft", async () => {
      vi.mocked(submitSection).mockRejectedValue(new Error("Conflict"));

      const res = await POST(makeRequest("POST", { action: "submit" }), makeCtx());

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });
  });

  describe("POST action=review", () => {
    it("reviews as a counselor", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);

      const res = await POST(makeRequest("POST", { action: "review" }), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        section: JSON.parse(JSON.stringify({ ...SECTION_DTO, state: "reviewed" })),
      });
      expect(reviewSection).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        sectionKey: SECTION_KEY,
      });
      expect(submitSection).not.toHaveBeenCalled();
    });

    it("reviews as an admin (admin ≥ counselor)", async () => {
      signInAs("admin@example.com", "admin");
      vi.mocked(requireCaseAccess).mockResolvedValue(ADMIN_ACCESS);

      const res = await POST(makeRequest("POST", { action: "review" }), makeCtx());

      expect(res.status).toBe(200);
      expect(reviewSection).toHaveBeenCalledWith(
        expect.objectContaining({ access: ADMIN_ACCESS }),
      );
    });

    it("returns 403 when a STUDENT attempts review (per-action gate)", async () => {
      const res = await POST(makeRequest("POST", { action: "review" }), makeCtx());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
      expect(reviewSection).not.toHaveBeenCalled();
    });

    it("returns 409 when the section is not in the submitted state", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);
      vi.mocked(reviewSection).mockRejectedValue(new Error("Conflict"));

      const res = await POST(makeRequest("POST", { action: "review" }), makeCtx());

      expect(res.status).toBe(409);
    });
  });

  describe("POST (shared)", () => {
    it("returns 400 for an unknown action (discriminated union)", async () => {
      const res = await POST(makeRequest("POST", { action: "approve" }), makeCtx());

      expect(res.status).toBe(400);
      expect(submitSection).not.toHaveBeenCalled();
      expect(reviewSection).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeRequest("POST"), makeCtx());

      expect(res.status).toBe(400);
      expect(submitSection).not.toHaveBeenCalled();
    });

    it("returns 404 for an unknown sectionKey, nothing written", async () => {
      const res = await POST(
        makeRequest("POST", { action: "submit" }),
        makeCtx(CASE_ID, "not_a_section"),
      );

      expect(res.status).toBe(404);
      expect(submitSection).not.toHaveBeenCalled();
    });

    it("returns 403 for a parent, nothing written", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(makeRequest("POST", { action: "submit" }), makeCtx());

      expect(res.status).toBe(403);
      expect(submitSection).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(makeRequest("POST", { action: "submit" }), makeCtx());

      expect(res.status).toBe(401);
      expect(submitSection).not.toHaveBeenCalled();
    });
  });
});
