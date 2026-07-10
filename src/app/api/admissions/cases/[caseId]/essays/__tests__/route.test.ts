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
// Stub only the db-backed essay operations the route calls (roleAtLeast from
// config stays real so the §2.4 per-field split is exercised for real).
vi.mock("@/lib/admissions/essays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/essays")>()),
  createEssay: vi.fn(),
  listEssaysForCase: vi.fn(),
  softDeleteEssay: vi.fn(),
  updateEssay: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  createEssay,
  listEssaysForCase,
  softDeleteEssay,
  updateEssay,
} from "@/lib/admissions/essays";
import { DELETE, GET, PATCH, POST } from "../route";
import type {
  AdmissionsEssayDto,
  AdmissionsEssayListRowDto,
} from "@/lib/admissions/essays";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ESSAY_ID = "22222222-2222-4222-8222-222222222222";
const LIST_ITEM_ID = "33333333-3333-4333-8333-333333333333";

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

const ADMIN_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "admin@example.com",
  role: "admin",
  isAdmin: true,
};

const ESSAY_DTO: AdmissionsEssayDto = {
  id: ESSAY_ID,
  caseId: CASE_ID,
  listItemId: null,
  prompt: "Common App personal statement",
  status: "drafting",
  counselorStage: null,
  deadline: "2026-10-15",
  driveUrl: "https://docs.google.com/document/d/abc",
  lastStudentUpdateAt: "2026-07-01T00:00:00.000Z",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const ESSAY_ROW: AdmissionsEssayListRowDto = {
  ...ESSAY_DTO,
  stalenessDays: 8,
  effectiveStage: "drafting",
};

function makeCtx(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function makeRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}/essays`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function makeDeleteRequest(essayId?: string) {
  const query = essayId === undefined ? "" : `?essayId=${essayId}`;
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/essays${query}`,
    { method: "DELETE" },
  );
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/cases/[caseId]/essays", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("student@example.com", "student");
    vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);
    vi.mocked(listEssaysForCase).mockResolvedValue([ESSAY_ROW]);
    vi.mocked(createEssay).mockResolvedValue(ESSAY_DTO);
    vi.mocked(updateEssay).mockResolvedValue(ESSAY_DTO);
    vi.mocked(softDeleteEssay).mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("returns the list rows at minRole student", async () => {
      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ essays: [ESSAY_ROW] });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(listEssaysForCase).toHaveBeenCalledWith(CASE_ID);
    });

    it("returns 403 for a parent (below the student bar)", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("mom@example.com", CASE_ID, "student");
      expect(listEssaysForCase).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(401);
      expect(listEssaysForCase).not.toHaveBeenCalled();
    });

    it("returns 500 JSON when the lib throws", async () => {
      vi.mocked(listEssaysForCase).mockRejectedValue(new Error("DB exploded"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
    });
  });

  describe("POST", () => {
    it("lets a student add an essay (self-report surface, §2.4)", async () => {
      const res = await POST(
        makeRequest("POST", {
          prompt: "Why this college?",
          listItemId: LIST_ITEM_ID,
          deadline: "2026-11-01",
          driveUrl: "https://docs.google.com/document/d/xyz",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ essay: ESSAY_DTO });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(createEssay).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        prompt: "Why this college?",
        listItemId: LIST_ITEM_ID,
        deadline: "2026-11-01",
        driveUrl: "https://docs.google.com/document/d/xyz",
      });
    });

    it("lets a counselor add an essay (attributed via access.role)", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);

      const res = await POST(makeRequest("POST", { prompt: "Personal statement" }), makeCtx());

      expect(res.status).toBe(200);
      expect(createEssay).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        prompt: "Personal statement",
        listItemId: undefined,
        deadline: undefined,
        driveUrl: undefined,
      });
    });

    it("returns 400 for an empty prompt", async () => {
      const res = await POST(makeRequest("POST", { prompt: "   " }), makeCtx());

      expect(res.status).toBe(400);
      expect(createEssay).not.toHaveBeenCalled();
    });

    it("returns 400 for a malformed deadline", async () => {
      const res = await POST(
        makeRequest("POST", { prompt: "Prompt", deadline: "01/11/2026" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createEssay).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeRequest("POST"), makeCtx());

      expect(res.status).toBe(400);
      expect(createEssay).not.toHaveBeenCalled();
    });

    it("returns 403 for a parent, nothing written", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(makeRequest("POST", { prompt: "Prompt" }), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("mom@example.com", CASE_ID, "student");
      expect(createEssay).not.toHaveBeenCalled();
    });

    it("returns 404 when listItemId is not a live list item of the case", async () => {
      vi.mocked(createEssay).mockRejectedValue(new Error("NotFound"));

      const res = await POST(
        makeRequest("POST", { prompt: "Prompt", listItemId: LIST_ITEM_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(makeRequest("POST", { prompt: "Prompt" }), makeCtx());

      expect(res.status).toBe(401);
      expect(createEssay).not.toHaveBeenCalled();
    });
  });

  describe("PATCH", () => {
    it("lets a student update status / prompt / driveUrl", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          essayId: ESSAY_ID,
          expectedUpdatedAt: "2026-07-01T00:00:00.000Z",
          status: "feedback",
          prompt: "Revised prompt",
          driveUrl: "https://docs.google.com/document/d/new",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ essay: ESSAY_DTO });
      expect(updateEssay).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        essayId: ESSAY_ID,
        expectedUpdatedAt: "2026-07-01T00:00:00.000Z",
        prompt: "Revised prompt",
        status: "feedback",
        driveUrl: "https://docs.google.com/document/d/new",
        counselorStage: undefined,
        deadline: undefined,
        listItemId: undefined,
      });
    });

    it("returns 403 when a student sets counselorStage (per-field split)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { essayId: ESSAY_ID, counselorStage: "final" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
      expect(updateEssay).not.toHaveBeenCalled();
    });

    it("returns 403 when a student sets the deadline (per-field split)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { essayId: ESSAY_ID, deadline: "2026-12-01" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(updateEssay).not.toHaveBeenCalled();
    });

    it("returns 403 when a student relinks listItemId (per-field split)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { essayId: ESSAY_ID, listItemId: LIST_ITEM_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(updateEssay).not.toHaveBeenCalled();
    });

    it("lets a counselor set counselorStage / deadline / listItemId", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);

      const res = await PATCH(
        makeRequest("PATCH", {
          essayId: ESSAY_ID,
          counselorStage: "feedback",
          deadline: "2026-12-01",
          listItemId: LIST_ITEM_ID,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(updateEssay).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        essayId: ESSAY_ID,
        expectedUpdatedAt: undefined,
        prompt: undefined,
        status: undefined,
        driveUrl: undefined,
        counselorStage: "feedback",
        deadline: "2026-12-01",
        listItemId: LIST_ITEM_ID,
      });
    });

    it("lets an admin clear counselorStage with an explicit null", async () => {
      signInAs("admin@example.com", "admin");
      vi.mocked(requireCaseAccess).mockResolvedValue(ADMIN_ACCESS);

      const res = await PATCH(
        makeRequest("PATCH", { essayId: ESSAY_ID, counselorStage: null }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(updateEssay).toHaveBeenCalledWith(
        expect.objectContaining({ access: ADMIN_ACCESS, counselorStage: null }),
      );
    });

    it("returns 400 for an unknown status (fail-closed)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { essayId: ESSAY_ID, status: "polishing" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateEssay).not.toHaveBeenCalled();
    });

    it("returns 400 when essayId is not a UUID", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { essayId: "not-a-uuid", status: "drafting" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateEssay).not.toHaveBeenCalled();
    });

    it("returns 409 on a stale expectedUpdatedAt (optimistic concurrency)", async () => {
      vi.mocked(updateEssay).mockRejectedValue(new Error("Conflict"));

      const res = await PATCH(
        makeRequest("PATCH", {
          essayId: ESSAY_ID,
          expectedUpdatedAt: "2026-06-30T00:00:00.000Z",
          status: "final",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });

    it("returns 404 when the essay does not exist in this case", async () => {
      vi.mocked(updateEssay).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeRequest("PATCH", { essayId: ESSAY_ID, status: "final" }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await PATCH(makeRequest("PATCH"), makeCtx());

      expect(res.status).toBe(400);
      expect(updateEssay).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("soft-deletes an essay via ?essayId= with the counselor bar", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);

      const res = await DELETE(makeDeleteRequest(ESSAY_ID), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(softDeleteEssay).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        essayId: ESSAY_ID,
      });
    });

    it("returns 400 when essayId is missing", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);

      const res = await DELETE(makeDeleteRequest(), makeCtx());

      expect(res.status).toBe(400);
      expect(softDeleteEssay).not.toHaveBeenCalled();
    });

    it("returns 403 for a student (below the counselor bar)", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await DELETE(makeDeleteRequest(ESSAY_ID), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(softDeleteEssay).not.toHaveBeenCalled();
    });

    it("returns 404 when the essay does not exist in this case", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);
      vi.mocked(softDeleteEssay).mockRejectedValue(new Error("NotFound"));

      const res = await DELETE(makeDeleteRequest(ESSAY_ID), makeCtx());

      expect(res.status).toBe(404);
    });
  });
});
