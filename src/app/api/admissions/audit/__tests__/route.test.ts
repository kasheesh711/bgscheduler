import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/auth` instantiates NextAuth at import time and `@/lib/db` pulls the
// Neon driver; stub both. Keep the real requireAdmissionsSession and
// admissionsErrorResponse (they carry the status mapping under test) but mock
// the per-request DB membership check and the audit read.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admissions/access")>();
  return { ...actual, requireCaseAccess: vi.fn() };
});
vi.mock("@/lib/admissions/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admissions/audit")>();
  return { ...actual, listCaseAuditLog: vi.fn() };
});

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import { listCaseAuditLog } from "@/lib/admissions/audit";
import { GET } from "@/app/api/admissions/audit/[caseId]/route";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";

const ADMIN_SESSION = {
  user: { email: "admin@example.com", name: "Admin", allowedPages: null },
};
const COUNSELOR_SESSION = {
  user: {
    email: "counselor@example.com",
    name: "Counselor",
    allowedPages: ["/admissions"],
    role: "counselor",
  },
};

const AUDIT_PAGE = {
  entries: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      caseId: CASE_ID,
      actorEmail: "counselor@example.com",
      actorRole: "counselor",
      entityType: "case",
      entityId: CASE_ID,
      action: "status_change",
      diff: { status: { old: "active", new: "committed" } },
      createdAt: "2026-07-09T00:00:00.000Z",
    },
  ],
  page: 1,
  pageSize: 50,
  totalCount: 1,
};

function getRequest(query = "") {
  return new NextRequest(`http://test.local/api/admissions/audit/${CASE_ID}${query}`);
}

function routeParams(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue(ADMIN_SESSION);
  vi.mocked(requireCaseAccess).mockResolvedValue({
    caseId: CASE_ID,
    email: "admin@example.com",
    role: "admin",
    isAdmin: true,
  });
  vi.mocked(listCaseAuditLog).mockResolvedValue(AUDIT_PAGE);
});

describe("GET /api/admissions/audit/[caseId]", () => {
  it("returns the audit page for an admin session with default pagination", async () => {
    const res = await GET(getRequest(), routeParams());

    expect(res.status).toBe(200);
    expect(requireCaseAccess).toHaveBeenCalledWith("admin@example.com", CASE_ID, "admin");
    expect(listCaseAuditLog).toHaveBeenCalledWith(CASE_ID, { page: 1, pageSize: 50 });
    await expect(res.json()).resolves.toEqual(AUDIT_PAGE);
  });

  it("coerces string pagination query params with z.coerce", async () => {
    const res = await GET(getRequest("?page=3&pageSize=25"), routeParams());

    expect(res.status).toBe(200);
    expect(listCaseAuditLog).toHaveBeenCalledWith(CASE_ID, { page: 3, pageSize: 25 });
  });

  it("returns 403 for a counselor session (admin only) without touching the DB", async () => {
    authMock.mockResolvedValue(COUNSELOR_SESSION);

    const res = await GET(getRequest(), routeParams());

    expect(res.status).toBe(403);
    expect(requireCaseAccess).not.toHaveBeenCalled();
    expect(listCaseAuditLog).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(getRequest(), routeParams());

    expect(res.status).toBe(401);
    expect(listCaseAuditLog).not.toHaveBeenCalled();
  });

  it("returns 404 when the case is missing (requireCaseAccess throws NotFound)", async () => {
    vi.mocked(requireCaseAccess).mockRejectedValue(new Error("NotFound"));

    const res = await GET(getRequest(), routeParams());

    expect(res.status).toBe(404);
    expect(listCaseAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 for a tampered caseId (requireCaseAccess fails closed)", async () => {
    vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

    const res = await GET(getRequest(), routeParams("not-a-uuid"));

    expect(res.status).toBe(403);
    expect(listCaseAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 for a zero page", async () => {
    const res = await GET(getRequest("?page=0"), routeParams());

    expect(res.status).toBe(400);
    expect(listCaseAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric pageSize", async () => {
    const res = await GET(getRequest("?pageSize=abc"), routeParams());

    expect(res.status).toBe(400);
    expect(listCaseAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 for a pageSize above the cap", async () => {
    const res = await GET(getRequest("?pageSize=500"), routeParams());

    expect(res.status).toBe(400);
    expect(listCaseAuditLog).not.toHaveBeenCalled();
  });

  it("returns 500 JSON when the audit read throws", async () => {
    vi.mocked(listCaseAuditLog).mockRejectedValue(new Error("DB exploded"));

    const res = await GET(getRequest(), routeParams());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Audit trail load failed" });
  });
});
