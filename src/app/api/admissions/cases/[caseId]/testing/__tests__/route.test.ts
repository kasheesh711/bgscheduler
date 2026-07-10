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
vi.mock("@/lib/admissions/testing", () => ({
  createSitting: vi.fn(),
  getBestScores: vi.fn(),
  listSittingsForCase: vi.fn(),
  softDeleteSitting: vi.fn(),
  updateSitting: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  createSitting,
  getBestScores,
  listSittingsForCase,
  softDeleteSitting,
  updateSitting,
} from "@/lib/admissions/testing";
import { DELETE, GET, PATCH, POST } from "../route";
import type {
  AdmissionsBestScore,
  AdmissionsTestSittingDto,
} from "@/lib/admissions/testing";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const SITTING_ID = "22222222-2222-4222-8222-222222222222";

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

const SITTING_DTO: AdmissionsTestSittingDto = {
  id: SITTING_ID,
  caseId: CASE_ID,
  testType: "sat",
  testDate: "2026-10-03",
  registrationDeadline: "2026-08-29",
  targetScore: "1500",
  actualScore: null,
  scoreReleasedToParent: false,
  accommodations: null,
  createdAt: "2026-07-01T03:00:00.000Z",
  updatedAt: "2026-07-01T03:00:00.000Z",
};

const BEST_SCORE: AdmissionsBestScore = {
  testType: "sat",
  sittingId: SITTING_ID,
  testDate: "2026-10-03",
  actualScore: "1450",
  numericScore: 1450,
  scoreReleasedToParent: false,
};

function makeCtx(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function makeRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}/testing`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function makeDeleteRequest(sittingId?: string) {
  const query = sittingId === undefined ? "" : `?sittingId=${sittingId}`;
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/testing${query}`,
    { method: "DELETE" },
  );
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/cases/[caseId]/testing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("student@example.com", "student");
    vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);
    vi.mocked(listSittingsForCase).mockResolvedValue([SITTING_DTO]);
    vi.mocked(getBestScores).mockResolvedValue([BEST_SCORE]);
    vi.mocked(createSitting).mockResolvedValue(SITTING_DTO);
    vi.mocked(updateSitting).mockResolvedValue(SITTING_DTO);
    vi.mocked(softDeleteSitting).mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("returns sittings + best scores with minRole student", async () => {
      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        sittings: [SITTING_DTO],
        bestScores: [BEST_SCORE],
      });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(listSittingsForCase).toHaveBeenCalledWith(CASE_ID);
      expect(getBestScores).toHaveBeenCalledWith(CASE_ID);
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(401);
      expect(listSittingsForCase).not.toHaveBeenCalled();
    });

    it("returns 403 for a parent (below the student bar)", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(listSittingsForCase).not.toHaveBeenCalled();
    });

    it("returns 500 JSON when the lib throws", async () => {
      vi.mocked(listSittingsForCase).mockRejectedValue(new Error("DB exploded"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
    });
  });

  describe("POST", () => {
    it("creates a sitting as the student (self-report surface)", async () => {
      const res = await POST(
        makeRequest("POST", {
          testType: "sat",
          testDate: "2026-10-03",
          targetScore: "1500",
          accommodations: "Extended time",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ sitting: SITTING_DTO });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(createSitting).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        testType: "sat",
        testDate: "2026-10-03",
        targetScore: "1500",
        accommodations: "Extended time",
      });
    });

    it("maps omitted optional fields for the lib", async () => {
      const res = await POST(
        makeRequest("POST", { testType: "ielts", testDate: "2026-11-14" }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(createSitting).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        testType: "ielts",
        testDate: "2026-11-14",
        targetScore: undefined,
        accommodations: null,
      });
    });

    it("returns 403 for a parent, nothing written", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(
        makeRequest("POST", { testType: "sat", testDate: "2026-10-03" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(createSitting).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(
        makeRequest("POST", { testType: "sat", testDate: "2026-10-03" }),
        makeCtx(),
      );

      expect(res.status).toBe(401);
      expect(createSitting).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeRequest("POST"), makeCtx());

      expect(res.status).toBe(400);
      expect(createSitting).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown testType (fail-closed)", async () => {
      const res = await POST(
        makeRequest("POST", { testType: "gmat", testDate: "2026-10-03" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createSitting).not.toHaveBeenCalled();
    });

    it("returns 400 for a malformed testDate", async () => {
      const res = await POST(
        makeRequest("POST", { testType: "sat", testDate: "10/03/2026" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createSitting).not.toHaveBeenCalled();
    });
  });

  describe("PATCH", () => {
    it("lets the student update self-report fields", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          sittingId: SITTING_ID,
          testDate: "2026-12-05",
          actualScore: "1480",
          accommodations: null,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ sitting: SITTING_DTO });
      expect(updateSitting).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        sittingId: SITTING_ID,
        expectedUpdatedAt: undefined,
        testType: undefined,
        testDate: "2026-12-05",
        registrationDeadline: undefined,
        targetScore: undefined,
        actualScore: "1480",
        accommodations: null,
        scoreReleasedToParent: undefined,
      });
    });

    it("returns 403 when a STUDENT sends scoreReleasedToParent (per-field gate, CM-83)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { sittingId: SITTING_ID, scoreReleasedToParent: true }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
      expect(updateSitting).not.toHaveBeenCalled();
    });

    it("lets a counselor set scoreReleasedToParent", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);

      const res = await PATCH(
        makeRequest("PATCH", { sittingId: SITTING_ID, scoreReleasedToParent: true }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(updateSitting).toHaveBeenCalledWith(
        expect.objectContaining({
          access: COUNSELOR_ACCESS,
          sittingId: SITTING_ID,
          scoreReleasedToParent: true,
        }),
      );
    });

    it("lets an admin set scoreReleasedToParent (admin ≥ counselor)", async () => {
      signInAs("admin@example.com", "admin");
      vi.mocked(requireCaseAccess).mockResolvedValue(ADMIN_ACCESS);

      const res = await PATCH(
        makeRequest("PATCH", { sittingId: SITTING_ID, scoreReleasedToParent: false }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(updateSitting).toHaveBeenCalledWith(
        expect.objectContaining({ scoreReleasedToParent: false }),
      );
    });

    it("returns 400 when sittingId is missing", async () => {
      const res = await PATCH(makeRequest("PATCH", { testDate: "2026-12-05" }), makeCtx());

      expect(res.status).toBe(400);
      expect(updateSitting).not.toHaveBeenCalled();
    });

    it("returns 400 when sittingId is not a UUID", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { sittingId: "not-a-uuid", testDate: "2026-12-05" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateSitting).not.toHaveBeenCalled();
    });

    it("returns 404 when the sitting does not exist in this case", async () => {
      vi.mocked(updateSitting).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeRequest("PATCH", { sittingId: SITTING_ID, testDate: "2026-12-05" }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 409 on an expectedUpdatedAt conflict", async () => {
      vi.mocked(updateSitting).mockRejectedValue(new Error("Conflict"));

      const res = await PATCH(
        makeRequest("PATCH", {
          sittingId: SITTING_ID,
          expectedUpdatedAt: "2026-07-01T00:00:00.000Z",
          testDate: "2026-12-05",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });

    it("returns 403 for a parent, nothing written", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { sittingId: SITTING_ID, testDate: "2026-12-05" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(updateSitting).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("deletes a sitting by ?sittingId= at the student bar", async () => {
      const res = await DELETE(makeDeleteRequest(SITTING_ID), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(softDeleteSitting).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        sittingId: SITTING_ID,
      });
    });

    it("returns 400 when sittingId is missing", async () => {
      const res = await DELETE(makeDeleteRequest(), makeCtx());

      expect(res.status).toBe(400);
      expect(softDeleteSitting).not.toHaveBeenCalled();
    });

    it("returns 400 when sittingId is not a UUID", async () => {
      const res = await DELETE(makeDeleteRequest("not-a-uuid"), makeCtx());

      expect(res.status).toBe(400);
      expect(softDeleteSitting).not.toHaveBeenCalled();
    });

    it("returns 404 when the sitting does not exist in this case", async () => {
      vi.mocked(softDeleteSitting).mockRejectedValue(new Error("NotFound"));

      const res = await DELETE(makeDeleteRequest(SITTING_ID), makeCtx());

      expect(res.status).toBe(404);
    });

    it("returns 403 for a parent, nothing deleted", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await DELETE(makeDeleteRequest(SITTING_ID), makeCtx());

      expect(res.status).toBe(403);
      expect(softDeleteSitting).not.toHaveBeenCalled();
    });
  });
});
