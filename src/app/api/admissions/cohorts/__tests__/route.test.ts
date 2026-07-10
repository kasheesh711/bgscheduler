import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/auth` instantiates NextAuth at import time and `@/lib/db` pulls the
// Neon driver; stub both so the real requireAdmissionsSession guard can run.
// The Postgres-resolved staff/admin guards (design §2.2) are mocked so their
// per-test outcome models the registry/admin_users state.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admissions/access")>();
  return {
    ...actual,
    requireAdmissionsAdmin: vi.fn(),
    requireCounselorOrAdmin: vi.fn(),
  };
});
vi.mock("@/lib/admissions/cohorts", () => ({
  listCohorts: vi.fn(),
  createCohort: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireAdmissionsAdmin, requireCounselorOrAdmin } from "@/lib/admissions/access";
import { createCohort, listCohorts } from "@/lib/admissions/cohorts";
import { GET, POST } from "@/app/api/admissions/cohorts/route";

const authMock = auth as unknown as Mock;

const ADMIN_STAFF = { email: "admin@example.com", role: "admin" as const, isAdmin: true };
const COUNSELOR_STAFF = {
  email: "counselor@example.com",
  role: "counselor" as const,
  isAdmin: false,
};

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
const STUDENT_SESSION = {
  user: {
    email: "student@example.com",
    name: "Student",
    allowedPages: ["/admissions"],
    role: "student",
  },
};

const COHORT = { id: "22222222-2222-4222-8222-222222222222", name: "Class of 2027", graduationYear: 2027 };

function postRequest(body?: unknown) {
  return new NextRequest("http://test.local/api/admissions/cohorts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("GET /api/admissions/cohorts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue(ADMIN_SESSION);
    vi.mocked(requireCounselorOrAdmin).mockResolvedValue(ADMIN_STAFF);
    vi.mocked(listCohorts).mockResolvedValue([COHORT]);
  });

  it("returns the cohort list for an admin session", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(requireCounselorOrAdmin).toHaveBeenCalledWith("admin@example.com");
    await expect(res.json()).resolves.toEqual({ cohorts: [COHORT] });
  });

  it("returns the cohort list for a counselor session", async () => {
    authMock.mockResolvedValue(COUNSELOR_SESSION);
    vi.mocked(requireCounselorOrAdmin).mockResolvedValue(COUNSELOR_STAFF);

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ cohorts: [COHORT] });
  });

  it("returns 403 for a student session (counselor+ only)", async () => {
    authMock.mockResolvedValue(STUDENT_SESSION);
    vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await GET();

    expect(res.status).toBe(403);
    expect(listCohorts).not.toHaveBeenCalled();
  });

  it("returns 403 for a deactivated counselor despite a staff JWT (instant revocation)", async () => {
    authMock.mockResolvedValue(COUNSELOR_SESSION);
    vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await GET();

    expect(res.status).toBe(403);
    expect(listCohorts).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(listCohorts).not.toHaveBeenCalled();
  });

  it("returns 500 JSON when the registry read throws", async () => {
    vi.mocked(listCohorts).mockRejectedValue(new Error("DB exploded"));

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Cohorts load failed" });
  });
});

describe("POST /api/admissions/cohorts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue(ADMIN_SESSION);
    vi.mocked(requireAdmissionsAdmin).mockResolvedValue(ADMIN_STAFF);
    vi.mocked(createCohort).mockResolvedValue(COHORT);
  });

  it("creates a cohort and coerces a string graduationYear", async () => {
    const res = await POST(postRequest({ name: "Class of 2027", graduationYear: "2027" }));

    expect(res.status).toBe(200);
    expect(requireAdmissionsAdmin).toHaveBeenCalledWith("admin@example.com");
    expect(createCohort).toHaveBeenCalledWith("Class of 2027", 2027);
    await expect(res.json()).resolves.toEqual({ cohort: COHORT });
  });

  it("returns 403 for a counselor session (admin only)", async () => {
    authMock.mockResolvedValue(COUNSELOR_SESSION);
    vi.mocked(requireAdmissionsAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await POST(postRequest({ name: "Class of 2027", graduationYear: 2027 }));

    expect(res.status).toBe(403);
    expect(createCohort).not.toHaveBeenCalled();
  });

  it("returns 403 for a removed admin despite an admin JWT (instant revocation)", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    vi.mocked(requireAdmissionsAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await POST(postRequest({ name: "Class of 2027", graduationYear: 2027 }));

    expect(res.status).toBe(403);
    expect(createCohort).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(postRequest({ name: "Class of 2027", graduationYear: 2027 }));

    expect(res.status).toBe(401);
    expect(createCohort).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing JSON body", async () => {
    const res = await POST(postRequest());

    expect(res.status).toBe(400);
    expect(createCohort).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty name", async () => {
    const res = await POST(postRequest({ name: "   ", graduationYear: 2027 }));

    expect(res.status).toBe(400);
    expect(createCohort).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-integer graduation year", async () => {
    const res = await POST(postRequest({ name: "Class of 2027", graduationYear: 2027.5 }));

    expect(res.status).toBe(400);
    expect(createCohort).not.toHaveBeenCalled();
  });

  it("returns 409 when the cohort name already exists", async () => {
    vi.mocked(createCohort).mockRejectedValue(new Error("Conflict"));

    const res = await POST(postRequest({ name: "Class of 2027", graduationYear: 2027 }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Conflict" });
  });

  it("returns 500 JSON when the insert fails unexpectedly", async () => {
    vi.mocked(createCohort).mockRejectedValue(new Error("connection refused"));

    const res = await POST(postRequest({ name: "Class of 2027", graduationYear: 2027 }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Cohort creation failed" });
  });
});
