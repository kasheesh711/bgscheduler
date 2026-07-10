import { describe, expect, beforeEach, it, vi } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/db` pulls the Neon driver and `@/lib/auth` executes NextAuth at
// import time; stub both. The access module is partially mocked so the real
// admissionsErrorResponse mapping (401/403/404/409/500) stays under test.
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admissions/access")>();
  return { ...actual, requireAdmissionsSession: vi.fn(), requireCaseAccess: vi.fn() };
});
vi.mock("@/lib/admissions/cases", () => ({ getCaseDetail: vi.fn() }));
vi.mock("@/lib/admissions/members", () => ({
  addMember: vi.fn(),
  changeMemberEmail: vi.fn(),
  reInvite: vi.fn(),
  rejectStudentAsParent: vi.fn(),
  revokeMember: vi.fn(),
}));

import { requireAdmissionsSession, requireCaseAccess } from "@/lib/admissions/access";
import { getCaseDetail } from "@/lib/admissions/cases";
import {
  addMember,
  changeMemberEmail,
  reInvite,
  rejectStudentAsParent,
  revokeMember,
} from "@/lib/admissions/members";
import { GET, PATCH, POST } from "@/app/api/admissions/cases/[caseId]/members/route";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "77777777-7777-4777-8777-777777777777";

const COUNSELOR = { email: "staff@example.com", name: "Staff", role: "counselor" as const };

const MEMBER = {
  id: MEMBER_ID,
  caseId: CASE_ID,
  email: "mom@example.com",
  role: "parent",
  status: "invited",
  invitedAt: "2026-07-01T00:00:00.000Z",
  activatedAt: null,
  revokedAt: null,
  addedByEmail: "staff@example.com",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function caseAccess(role: "counselor" | "admin") {
  return {
    caseId: CASE_ID,
    email: role === "admin" ? "admin@example.com" : "staff@example.com",
    role,
    isAdmin: role === "admin",
  };
}

function routeContext(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function jsonRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}/members`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const getRequest = new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}/members`);

describe("/api/admissions/cases/[caseId]/members", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireAdmissionsSession).mockResolvedValue(COUNSELOR);
    vi.mocked(requireCaseAccess).mockResolvedValue(caseAccess("counselor"));
    vi.mocked(getCaseDetail).mockResolvedValue({ members: [MEMBER] } as never);
    vi.mocked(rejectStudentAsParent).mockResolvedValue(undefined);
    vi.mocked(addMember).mockResolvedValue(MEMBER as never);
    vi.mocked(revokeMember).mockResolvedValue({ ...MEMBER, status: "revoked" } as never);
    vi.mocked(reInvite).mockResolvedValue(MEMBER as never);
    vi.mocked(changeMemberEmail).mockResolvedValue(MEMBER as never);
  });

  describe("GET", () => {
    it("returns every membership row for a counselor", async () => {
      const res = await GET(getRequest, routeContext());

      expect(res.status).toBe(200);
      expect(requireCaseAccess).toHaveBeenCalledWith("staff@example.com", CASE_ID, "counselor");
      await expect(res.json()).resolves.toEqual({ members: [MEMBER] });
    });

    it("returns 401 when unauthenticated", async () => {
      vi.mocked(requireAdmissionsSession).mockRejectedValue(new Error("Unauthorized"));

      const res = await GET(getRequest, routeContext());

      expect(res.status).toBe(401);
      expect(getCaseDetail).not.toHaveBeenCalled();
    });

    it("returns 403 for a member below counselor or a cross-case counselor", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(getRequest, routeContext());

      expect(res.status).toBe(403);
      expect(getCaseDetail).not.toHaveBeenCalled();
    });
  });

  describe("POST", () => {
    it("adds a parent after the student-as-parent guard", async () => {
      const res = await POST(
        jsonRequest("POST", { email: "mom@example.com", role: "parent" }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(rejectStudentAsParent).toHaveBeenCalledWith({
        caseId: CASE_ID,
        parentEmails: ["mom@example.com"],
        adminOverride: false,
      });
      expect(addMember).toHaveBeenCalledWith({
        caseId: CASE_ID,
        email: "mom@example.com",
        role: "parent",
        actor: { email: "staff@example.com", role: "counselor" },
        adminOverride: false,
      });
      await expect(res.json()).resolves.toEqual({ member: MEMBER });
    });

    it("adds a counselor without invoking the parent guard", async () => {
      const res = await POST(
        jsonRequest("POST", { email: "co@example.com", role: "counselor" }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(rejectStudentAsParent).not.toHaveBeenCalled();
      expect(addMember).toHaveBeenCalledWith(
        expect.objectContaining({ email: "co@example.com", role: "counselor" }),
      );
    });

    it("keeps revoked counselor reactivation on the existing add-member POST contract", async () => {
      const reinstated = {
        ...MEMBER,
        email: "former.counselor@example.com",
        role: "counselor" as const,
        status: "active" as const,
        invitedAt: null,
        activatedAt: "2026-07-10T00:00:00.000Z",
        revokedAt: null,
      };
      vi.mocked(addMember).mockResolvedValue(reinstated);

      const res = await POST(
        jsonRequest("POST", {
          email: "former.counselor@example.com",
          role: "counselor",
        }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(addMember).toHaveBeenCalledWith(
        expect.objectContaining({
          caseId: CASE_ID,
          email: "former.counselor@example.com",
          role: "counselor",
        }),
      );
      await expect(res.json()).resolves.toEqual({ member: reinstated });
    });

    it("ignores adminOverride from a counselor session (fail-closed)", async () => {
      const res = await POST(
        jsonRequest("POST", { email: "mom@example.com", role: "parent", adminOverride: true }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(rejectStudentAsParent).toHaveBeenCalledWith(
        expect.objectContaining({ adminOverride: false }),
      );
      expect(addMember).toHaveBeenCalledWith(
        expect.objectContaining({ adminOverride: false }),
      );
    });

    it("honors adminOverride from an admin session", async () => {
      vi.mocked(requireCaseAccess).mockResolvedValue(caseAccess("admin"));

      const res = await POST(
        jsonRequest("POST", { email: "mom@example.com", role: "parent", adminOverride: true }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(rejectStudentAsParent).toHaveBeenCalledWith(
        expect.objectContaining({ adminOverride: true }),
      );
      expect(addMember).toHaveBeenCalledWith(
        expect.objectContaining({ adminOverride: true }),
      );
    });

    it("returns 400 for role student (single student membership is case-created)", async () => {
      const res = await POST(
        jsonRequest("POST", { email: "ada@example.com", role: "student" }),
        routeContext(),
      );

      expect(res.status).toBe(400);
      expect(addMember).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid email", async () => {
      const res = await POST(
        jsonRequest("POST", { email: "not-an-email", role: "parent" }),
        routeContext(),
      );

      expect(res.status).toBe(400);
      expect(addMember).not.toHaveBeenCalled();
    });

    it("returns 400 for an unparseable JSON body", async () => {
      const res = await POST(jsonRequest("POST"), routeContext());

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
    });

    it("returns 409 when the student-as-parent guard rejects", async () => {
      vi.mocked(rejectStudentAsParent).mockRejectedValue(new Error("Conflict"));

      const res = await POST(
        jsonRequest("POST", { email: "ada@example.com", role: "parent" }),
        routeContext(),
      );

      expect(res.status).toBe(409);
      expect(addMember).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      vi.mocked(requireAdmissionsSession).mockRejectedValue(new Error("Unauthorized"));

      const res = await POST(
        jsonRequest("POST", { email: "mom@example.com", role: "parent" }),
        routeContext(),
      );

      expect(res.status).toBe(401);
      expect(addMember).not.toHaveBeenCalled();
    });

    it("returns 403 for a member below counselor", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(
        jsonRequest("POST", { email: "mom@example.com", role: "parent" }),
        routeContext(),
      );

      expect(res.status).toBe(403);
      expect(addMember).not.toHaveBeenCalled();
    });
  });

  describe("PATCH", () => {
    it("revokes a member", async () => {
      const res = await PATCH(
        jsonRequest("PATCH", { action: "revoke", memberId: MEMBER_ID }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(revokeMember).toHaveBeenCalledWith({
        caseId: CASE_ID,
        memberId: MEMBER_ID,
        actor: { email: "staff@example.com", role: "counselor" },
      });
      await expect(res.json()).resolves.toEqual({
        member: { ...MEMBER, status: "revoked" },
      });
    });

    it("re-invites a member", async () => {
      const res = await PATCH(
        jsonRequest("PATCH", {
          action: "reinvite",
          memberId: MEMBER_ID,
          expectedUpdatedAt: MEMBER.updatedAt,
        }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(reInvite).toHaveBeenCalledWith({
        caseId: CASE_ID,
        memberId: MEMBER_ID,
        actor: { email: "staff@example.com", role: "counselor" },
        expectedUpdatedAt: MEMBER.updatedAt,
      });
    });

    it("requires the membership concurrency token for re-invite", async () => {
      const res = await PATCH(
        jsonRequest("PATCH", { action: "reinvite", memberId: MEMBER_ID }),
        routeContext(),
      );

      expect(res.status).toBe(400);
      expect(reInvite).not.toHaveBeenCalled();
    });

    it("changes a member email with adminOverride gated off for counselors", async () => {
      const res = await PATCH(
        jsonRequest("PATCH", {
          action: "change_email",
          memberId: MEMBER_ID,
          newEmail: "new@example.com",
          adminOverride: true,
        }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(changeMemberEmail).toHaveBeenCalledWith({
        caseId: CASE_ID,
        memberId: MEMBER_ID,
        newEmail: "new@example.com",
        actor: { email: "staff@example.com", role: "counselor" },
        adminOverride: false,
      });
    });

    it("honors adminOverride on change_email for an admin session", async () => {
      vi.mocked(requireCaseAccess).mockResolvedValue(caseAccess("admin"));

      const res = await PATCH(
        jsonRequest("PATCH", {
          action: "change_email",
          memberId: MEMBER_ID,
          newEmail: "new@example.com",
          adminOverride: true,
        }),
        routeContext(),
      );

      expect(res.status).toBe(200);
      expect(changeMemberEmail).toHaveBeenCalledWith(
        expect.objectContaining({ adminOverride: true }),
      );
    });

    it("returns 400 for an unknown action", async () => {
      const res = await PATCH(
        jsonRequest("PATCH", { action: "promote", memberId: MEMBER_ID }),
        routeContext(),
      );

      expect(res.status).toBe(400);
      expect(revokeMember).not.toHaveBeenCalled();
      expect(reInvite).not.toHaveBeenCalled();
      expect(changeMemberEmail).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-uuid memberId", async () => {
      const res = await PATCH(
        jsonRequest("PATCH", { action: "revoke", memberId: "nope" }),
        routeContext(),
      );

      expect(res.status).toBe(400);
      expect(revokeMember).not.toHaveBeenCalled();
    });

    it("returns 404 when the member does not exist on this case", async () => {
      vi.mocked(revokeMember).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        jsonRequest("PATCH", { action: "revoke", memberId: MEMBER_ID }),
        routeContext(),
      );

      expect(res.status).toBe(404);
    });

    it("returns 409 when re-inviting an active member", async () => {
      vi.mocked(reInvite).mockRejectedValue(new Error("Conflict"));

      const res = await PATCH(
        jsonRequest("PATCH", {
          action: "reinvite",
          memberId: MEMBER_ID,
          expectedUpdatedAt: MEMBER.updatedAt,
        }),
        routeContext(),
      );

      expect(res.status).toBe(409);
    });

    it("returns 401 when unauthenticated", async () => {
      vi.mocked(requireAdmissionsSession).mockRejectedValue(new Error("Unauthorized"));

      const res = await PATCH(
        jsonRequest("PATCH", { action: "revoke", memberId: MEMBER_ID }),
        routeContext(),
      );

      expect(res.status).toBe(401);
      expect(revokeMember).not.toHaveBeenCalled();
    });
  });
});
