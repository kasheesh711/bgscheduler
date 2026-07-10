import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/auth` instantiates NextAuth at import time and `@/lib/db` pulls the
// Neon driver; stub both so the route can be unit-tested in isolation.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
// Keep the real requireAdmissionsSession + admissionsErrorResponse (driven via
// the auth mock); stub the db-backed staff check.
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCounselorOrAdmin: vi.fn(),
}));
// Keep the real topic guard + URL schema (they drive the route's Zod schemas);
// stub only the db-backed lib functions.
vi.mock("@/lib/admissions/resources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/resources")>()),
  createResource: vi.fn(),
  listResources: vi.fn(),
  softDeleteResource: vi.fn(),
  updateResource: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCounselorOrAdmin } from "@/lib/admissions/access";
import {
  createResource,
  listResources,
  softDeleteResource,
  updateResource,
} from "@/lib/admissions/resources";
import { DELETE, GET, PATCH, POST } from "../route";
import type { AdmissionsStaffAccess } from "@/lib/admissions/access";

const authMock = auth as unknown as Mock;

const RESOURCE_ID = "33333333-3333-4333-8333-333333333333";

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

const RESOURCE_DTO = {
  id: RESOURCE_ID,
  topic: "essays",
  title: "College Essay Guy",
  url: "https://www.collegeessayguy.com",
  sortOrder: 0,
  createdAt: "2026-07-01T03:00:00.000Z",
  updatedAt: "2026-07-01T03:00:00.000Z",
};

const GROUPS = [
  { topic: "essays", label: "Essays", resources: [RESOURCE_DTO] },
];

function makeGetRequest() {
  return new NextRequest("http://test.local/api/admissions/resources");
}

function makeBodyRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest("http://test.local/api/admissions/resources", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function makeDeleteRequest(query: string) {
  return new NextRequest(`http://test.local/api/admissions/resources${query}`, {
    method: "DELETE",
  });
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/resources", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("counselor@example.com", "counselor");
    vi.mocked(requireCounselorOrAdmin).mockResolvedValue(COUNSELOR_STAFF);
    vi.mocked(listResources).mockResolvedValue(GROUPS);
    vi.mocked(createResource).mockResolvedValue(RESOURCE_DTO);
    vi.mocked(updateResource).mockResolvedValue(RESOURCE_DTO);
    vi.mocked(softDeleteResource).mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("returns the grouped library to a student (any admissions role reads)", async () => {
      signInAs("student@example.com", "student");

      const res = await GET();

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ groups: GROUPS });
      // Reads never hit the staff gate — the library is family-visible.
      expect(requireCounselorOrAdmin).not.toHaveBeenCalled();
    });

    it("returns the grouped library to a parent", async () => {
      signInAs("parent@example.com", "parent");

      const res = await GET();

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ groups: GROUPS });
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET();

      expect(res.status).toBe(401);
      expect(listResources).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-admissions role (fail-closed)", async () => {
      signInAs("teacher@example.com", "teacher");

      const res = await GET();

      expect(res.status).toBe(403);
      expect(listResources).not.toHaveBeenCalled();
    });
  });

  describe("POST", () => {
    const VALID_BODY = {
      topic: "essays",
      title: "College Essay Guy",
      url: "https://www.collegeessayguy.com",
    };

    it("creates a resource behind the staff gate (counselor)", async () => {
      const res = await POST(makeBodyRequest("POST", VALID_BODY));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ resource: RESOURCE_DTO });
      expect(requireCounselorOrAdmin).toHaveBeenCalledWith("counselor@example.com");
      expect(createResource).toHaveBeenCalledWith({
        topic: "essays",
        title: "College Essay Guy",
        url: "https://www.collegeessayguy.com",
        sortOrder: undefined,
        actorEmail: "counselor@example.com",
        actorRole: "counselor",
      });
    });

    it("creates a resource as admin with an explicit sortOrder", async () => {
      signInAs("admin@example.com", "admin");
      vi.mocked(requireCounselorOrAdmin).mockResolvedValue(ADMIN_STAFF);

      const res = await POST(makeBodyRequest("POST", { ...VALID_BODY, sortOrder: 2 }));

      expect(res.status).toBe(200);
      expect(createResource).toHaveBeenCalledWith(expect.objectContaining({
        sortOrder: 2,
        actorEmail: "admin@example.com",
        actorRole: "admin",
      }));
    });

    it("returns 403 for a student before anything is written", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(makeBodyRequest("POST", VALID_BODY));

      expect(res.status).toBe(403);
      expect(createResource).not.toHaveBeenCalled();
    });

    it("returns 403 for a parent before anything is written", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(makeBodyRequest("POST", VALID_BODY));

      expect(res.status).toBe(403);
      expect(createResource).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown topic", async () => {
      const res = await POST(makeBodyRequest("POST", { ...VALID_BODY, topic: "bogus" }));

      expect(res.status).toBe(400);
      expect(createResource).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-https or malformed URL", async () => {
      for (const url of ["http://insecure.example.com", "not a url", ""]) {
        const res = await POST(makeBodyRequest("POST", { ...VALID_BODY, url }));
        expect(res.status).toBe(400);
      }
      expect(createResource).not.toHaveBeenCalled();
    });

    it("returns 400 for an empty title", async () => {
      const res = await POST(makeBodyRequest("POST", { ...VALID_BODY, title: "   " }));

      expect(res.status).toBe(400);
      expect(createResource).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeBodyRequest("POST"));

      expect(res.status).toBe(400);
      expect(createResource).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(makeBodyRequest("POST", VALID_BODY));

      expect(res.status).toBe(401);
      expect(createResource).not.toHaveBeenCalled();
    });
  });

  describe("PATCH", () => {
    it("updates a resource behind the staff gate", async () => {
      const res = await PATCH(
        makeBodyRequest("PATCH", { resourceId: RESOURCE_ID, title: "New title" }),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ resource: RESOURCE_DTO });
      expect(requireCounselorOrAdmin).toHaveBeenCalledWith("counselor@example.com");
      expect(updateResource).toHaveBeenCalledWith({
        resourceId: RESOURCE_ID,
        actorEmail: "counselor@example.com",
        actorRole: "counselor",
        topic: undefined,
        title: "New title",
        url: undefined,
        sortOrder: undefined,
      });
    });

    it("returns 403 when the caller is not staff", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeBodyRequest("PATCH", { resourceId: RESOURCE_ID, title: "x" }),
      );

      expect(res.status).toBe(403);
      expect(updateResource).not.toHaveBeenCalled();
    });

    it("returns 400 when resourceId is missing or not a uuid", async () => {
      for (const body of [{ title: "x" }, { resourceId: "not-a-uuid", title: "x" }]) {
        const res = await PATCH(makeBodyRequest("PATCH", body));
        expect(res.status).toBe(400);
      }
      expect(updateResource).not.toHaveBeenCalled();
    });

    it("returns 400 when no updatable field is provided", async () => {
      const res = await PATCH(makeBodyRequest("PATCH", { resourceId: RESOURCE_ID }));

      expect(res.status).toBe(400);
      expect(updateResource).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-https URL", async () => {
      const res = await PATCH(
        makeBodyRequest("PATCH", { resourceId: RESOURCE_ID, url: "http://x.example.com" }),
      );

      expect(res.status).toBe(400);
      expect(updateResource).not.toHaveBeenCalled();
    });

    it("returns 404 when the resource does not exist", async () => {
      vi.mocked(updateResource).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeBodyRequest("PATCH", { resourceId: RESOURCE_ID, title: "x" }),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await PATCH(
        makeBodyRequest("PATCH", { resourceId: RESOURCE_ID, title: "x" }),
      );

      expect(res.status).toBe(401);
      expect(updateResource).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("soft-deletes a resource behind the staff gate", async () => {
      const res = await DELETE(makeDeleteRequest(`?resourceId=${RESOURCE_ID}`));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(requireCounselorOrAdmin).toHaveBeenCalledWith("counselor@example.com");
      expect(softDeleteResource).toHaveBeenCalledWith({
        resourceId: RESOURCE_ID,
        actorEmail: "counselor@example.com",
        actorRole: "counselor",
      });
    });

    it("returns 400 when resourceId is missing or not a uuid", async () => {
      for (const query of ["", "?resourceId=not-a-uuid"]) {
        const res = await DELETE(makeDeleteRequest(query));
        expect(res.status).toBe(400);
      }
      expect(softDeleteResource).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller is not staff", async () => {
      signInAs("parent@example.com", "parent");
      vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

      const res = await DELETE(makeDeleteRequest(`?resourceId=${RESOURCE_ID}`));

      expect(res.status).toBe(403);
      expect(softDeleteResource).not.toHaveBeenCalled();
    });

    it("returns 404 when the resource is missing or already deleted", async () => {
      vi.mocked(softDeleteResource).mockRejectedValue(new Error("NotFound"));

      const res = await DELETE(makeDeleteRequest(`?resourceId=${RESOURCE_ID}`));

      expect(res.status).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await DELETE(makeDeleteRequest(`?resourceId=${RESOURCE_ID}`));

      expect(res.status).toBe(401);
      expect(softDeleteResource).not.toHaveBeenCalled();
    });
  });
});
