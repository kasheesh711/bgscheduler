import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/auth` instantiates NextAuth at import time and `@/lib/db` pulls the
// Neon driver; stub both so the real requireAdmissionsSession guard can run.
// The Postgres-resolved admin guard (design §2.2) is mocked so its per-test
// outcome models the admin_users state — never the JWT role claim.
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
vi.mock("@/lib/admissions/counselors", () => ({
  listCounselors: vi.fn(),
  upsertCounselor: vi.fn(),
  deactivateCounselor: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireAdmissionsAdmin, requireCounselorOrAdmin } from "@/lib/admissions/access";
import {
  deactivateCounselor,
  listCounselors,
  upsertCounselor,
} from "@/lib/admissions/counselors";
import { GET, PATCH, POST } from "@/app/api/admissions/counselors/route";

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

const COUNSELOR_DTO = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "amy@example.com",
  name: "Amy",
  active: true,
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
};

const ADMIN_ACTOR = { email: "admin@example.com", role: "admin" };

function jsonRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest("http://test.local/api/admissions/counselors", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue(ADMIN_SESSION);
  vi.mocked(requireAdmissionsAdmin).mockResolvedValue(ADMIN_STAFF);
  vi.mocked(requireCounselorOrAdmin).mockResolvedValue(ADMIN_STAFF);
  vi.mocked(listCounselors).mockResolvedValue([COUNSELOR_DTO]);
  vi.mocked(upsertCounselor).mockResolvedValue(COUNSELOR_DTO);
  vi.mocked(deactivateCounselor).mockResolvedValue({ ...COUNSELOR_DTO, active: false });
});

describe("GET /api/admissions/counselors", () => {
  it("returns the registry for an admin session", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ counselors: [COUNSELOR_DTO] });
  });

  it("returns only active assignment choices for a counselor session", async () => {
    authMock.mockResolvedValue(COUNSELOR_SESSION);
    vi.mocked(requireCounselorOrAdmin).mockResolvedValue(COUNSELOR_STAFF);
    vi.mocked(listCounselors).mockResolvedValue([
      COUNSELOR_DTO,
      { ...COUNSELOR_DTO, id: "44444444-4444-4444-8444-444444444444", email: "inactive@example.com", active: false },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ counselors: [COUNSELOR_DTO] });
  });

  it("returns 403 for a removed admin despite an admin JWT (instant revocation)", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await GET();

    expect(res.status).toBe(403);
    expect(listCounselors).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(listCounselors).not.toHaveBeenCalled();
  });

  it("returns 500 JSON when the registry read throws", async () => {
    vi.mocked(listCounselors).mockRejectedValue(new Error("DB exploded"));

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Counselors load failed" });
  });
});

describe("POST /api/admissions/counselors", () => {
  it("upserts a counselor with the admin actor and default active=true", async () => {
    const res = await POST(jsonRequest("POST", { email: "amy@example.com", name: "Amy" }));

    expect(res.status).toBe(200);
    expect(upsertCounselor).toHaveBeenCalledWith("amy@example.com", "Amy", true, ADMIN_ACTOR);
    await expect(res.json()).resolves.toEqual({ counselor: COUNSELOR_DTO });
  });

  it("passes an explicit active=false through", async () => {
    const res = await POST(
      jsonRequest("POST", { email: "amy@example.com", name: "Amy", active: false }),
    );

    expect(res.status).toBe(200);
    expect(upsertCounselor).toHaveBeenCalledWith("amy@example.com", "Amy", false, ADMIN_ACTOR);
  });

  it("returns 403 for a counselor session (admin only)", async () => {
    authMock.mockResolvedValue(COUNSELOR_SESSION);
    vi.mocked(requireAdmissionsAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await POST(jsonRequest("POST", { email: "amy@example.com", name: "Amy" }));

    expect(res.status).toBe(403);
    expect(upsertCounselor).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid email", async () => {
    const res = await POST(jsonRequest("POST", { email: "not-an-email", name: "Amy" }));

    expect(res.status).toBe(400);
    expect(upsertCounselor).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing JSON body", async () => {
    const res = await POST(jsonRequest("POST"));

    expect(res.status).toBe(400);
    expect(upsertCounselor).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admissions/counselors", () => {
  it("routes a full update (name + explicit active) to upsertCounselor", async () => {
    const res = await PATCH(
      jsonRequest("PATCH", { email: "amy@example.com", name: "Amy Chen", active: false }),
    );

    expect(res.status).toBe(200);
    expect(upsertCounselor).toHaveBeenCalledWith("amy@example.com", "Amy Chen", false, ADMIN_ACTOR);
    expect(deactivateCounselor).not.toHaveBeenCalled();
  });

  it("routes a pure deactivation ({ email, active: false }) to deactivateCounselor", async () => {
    const res = await PATCH(jsonRequest("PATCH", { email: "amy@example.com", active: false }));

    expect(res.status).toBe(200);
    expect(deactivateCounselor).toHaveBeenCalledWith("amy@example.com", ADMIN_ACTOR);
    expect(upsertCounselor).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ counselor: { ...COUNSELOR_DTO, active: false } });
  });

  it("returns 404 when deactivating an unknown counselor", async () => {
    vi.mocked(deactivateCounselor).mockRejectedValue(new Error("NotFound"));

    const res = await PATCH(jsonRequest("PATCH", { email: "ghost@example.com", active: false }));

    expect(res.status).toBe(404);
  });

  it("returns 400 when active=true arrives without a name (never guess a rename)", async () => {
    const res = await PATCH(jsonRequest("PATCH", { email: "amy@example.com", active: true }));

    expect(res.status).toBe(400);
    expect(upsertCounselor).not.toHaveBeenCalled();
    expect(deactivateCounselor).not.toHaveBeenCalled();
  });

  it("returns 400 when only an email is provided", async () => {
    const res = await PATCH(jsonRequest("PATCH", { email: "amy@example.com" }));

    expect(res.status).toBe(400);
  });

  it("returns 403 for a counselor session (admin only)", async () => {
    authMock.mockResolvedValue(COUNSELOR_SESSION);
    vi.mocked(requireAdmissionsAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await PATCH(jsonRequest("PATCH", { email: "amy@example.com", active: false }));

    expect(res.status).toBe(403);
    expect(deactivateCounselor).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await PATCH(jsonRequest("PATCH", { email: "amy@example.com", active: false }));

    expect(res.status).toBe(401);
    expect(deactivateCounselor).not.toHaveBeenCalled();
  });
});
