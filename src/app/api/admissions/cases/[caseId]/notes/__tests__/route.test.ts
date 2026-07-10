import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/auth` instantiates NextAuth at import time and `@/lib/db` pulls the
// Neon driver; stub both so the route can be unit-tested in isolation.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
// Keep the real requireAdmissionsSession + admissionsErrorResponse (driven via
// the auth mock); only the db-backed per-case membership check is stubbed.
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCaseAccess: vi.fn(),
}));
// listNotesForRole stays REAL (fed rows via the getDb mock) so the GET tests
// exercise the actual staff_only visibility filter end to end.
vi.mock("@/lib/admissions/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/notes")>()),
  createNote: vi.fn(),
  updateNoteVisibility: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import { requireCaseAccess } from "@/lib/admissions/access";
import { createNote, updateNoteVisibility } from "@/lib/admissions/notes";
import { GET, PATCH, POST } from "../route";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = new Date("2026-07-01T00:00:00Z");

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

const STAFF_ROW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  caseId: CASE_ID,
  authorEmail: "counselor@example.com",
  body: "internal: family is price-sensitive",
  visibility: "staff_only",
  deletedAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const SHARED_ROW = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  caseId: CASE_ID,
  authorEmail: "counselor@example.com",
  body: "Great progress on the main essay this week",
  visibility: "shared_with_family",
  deletedAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const NOTE_DTO = {
  id: NOTE_ID,
  caseId: CASE_ID,
  authorEmail: "counselor@example.com",
  body: "A brand-new note",
  visibility: "shared_with_family" as const,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

/**
 * Minimal chainable select-only Drizzle stand-in: the real listNotesForRole
 * runs select().from().where().orderBy() and awaits the result. The SQL-level
 * visibility filter is deliberately NOT simulated — every seeded row comes
 * back, so the in-process defense-in-depth filter is what the tests observe.
 */
function fakeSelectDb(rows: unknown[]): Database {
  const builder = {
    from: () => builder,
    where: () => builder,
    orderBy: () => Promise.resolve(rows),
  };
  return { select: () => builder } as unknown as Database;
}

function makeCtx(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function makeRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}/notes`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/cases/[caseId]/notes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("counselor@example.com", "counselor");
    vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);
    vi.mocked(getDb).mockReturnValue(fakeSelectDb([STAFF_ROW, SHARED_ROW]));
    vi.mocked(createNote).mockResolvedValue(NOTE_DTO);
    vi.mocked(updateNoteVisibility).mockResolvedValue(NOTE_DTO);
  });

  describe("GET", () => {
    it("returns every note (incl. staff_only) for a counselor reader", async () => {
      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.notes).toHaveLength(2);
      expect(payload.notes.map((note: { visibility: string }) => note.visibility)).toEqual([
        "staff_only",
        "shared_with_family",
      ]);
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "student");
    });

    it("never serializes staff_only notes for a student reader", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain("staff_only");
      expect(raw).not.toContain("price-sensitive");
      const payload = JSON.parse(raw) as { notes: Array<{ id: string; visibility: string }> };
      expect(payload.notes).toHaveLength(1);
      expect(payload.notes[0]).toMatchObject({
        id: SHARED_ROW.id,
        visibility: "shared_with_family",
      });
    });

    it("never serializes staff_only notes for a parent reader", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCaseAccess).mockResolvedValue({
        caseId: CASE_ID,
        email: "parent@example.com",
        role: "parent",
        isAdmin: false,
      });

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain("staff_only");
      expect(JSON.parse(raw).notes).toHaveLength(1);
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(401);
      expect(requireCaseAccess).not.toHaveBeenCalled();
    });

    it("returns 403 when the session lacks /admissions page access", async () => {
      authMock.mockResolvedValue({
        user: { email: "other@example.com", name: "Other", allowedPages: ["/credit-control"] },
      });

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller is not a member of the case", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
    });
  });

  describe("POST", () => {
    it("creates a note with an explicit visibility", async () => {
      const res = await POST(
        makeRequest("POST", { body: "A brand-new note", visibility: "shared_with_family" }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ note: NOTE_DTO });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(createNote).toHaveBeenCalledWith({
        caseId: CASE_ID,
        authorEmail: "counselor@example.com",
        actorRole: "counselor",
        body: "A brand-new note",
        visibility: "shared_with_family",
      });
    });

    it("returns 400 when visibility is missing — there is NO default", async () => {
      const res = await POST(makeRequest("POST", { body: "A brand-new note" }), makeCtx());

      expect(res.status).toBe(400);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown visibility value", async () => {
      const res = await POST(
        makeRequest("POST", { body: "A brand-new note", visibility: "public" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("returns 400 for a blank body", async () => {
      const res = await POST(
        makeRequest("POST", { body: "   ", visibility: "staff_only" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeRequest("POST"), makeCtx());

      expect(res.status).toBe(400);
      expect(createNote).not.toHaveBeenCalled();
    });

    it("requires the counselor bar (below → 403, nothing written)", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(
        makeRequest("POST", { body: "A brand-new note", visibility: "staff_only" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(createNote).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(
        makeRequest("POST", { body: "A brand-new note", visibility: "staff_only" }),
        makeCtx(),
      );

      expect(res.status).toBe(401);
      expect(createNote).not.toHaveBeenCalled();
    });
  });

  describe("PATCH", () => {
    it("changes a note's visibility", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { noteId: NOTE_ID, visibility: "staff_only" }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ note: NOTE_DTO });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(updateNoteVisibility).toHaveBeenCalledWith({
        caseId: CASE_ID,
        noteId: NOTE_ID,
        actorEmail: "counselor@example.com",
        actorRole: "counselor",
        visibility: "staff_only",
      });
    });

    it("returns 400 when visibility is missing", async () => {
      const res = await PATCH(makeRequest("PATCH", { noteId: NOTE_ID }), makeCtx());

      expect(res.status).toBe(400);
      expect(updateNoteVisibility).not.toHaveBeenCalled();
    });

    it("returns 400 when noteId is not a UUID", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { noteId: "not-a-uuid", visibility: "staff_only" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateNoteVisibility).not.toHaveBeenCalled();
    });

    it("returns 404 when the note does not exist in this case", async () => {
      vi.mocked(updateNoteVisibility).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeRequest("PATCH", { noteId: NOTE_ID, visibility: "staff_only" }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 403 when the caller is below counselor", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { noteId: NOTE_ID, visibility: "staff_only" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(updateNoteVisibility).not.toHaveBeenCalled();
    });
  });
});
