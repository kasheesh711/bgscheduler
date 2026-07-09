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
vi.mock("@/lib/admissions/meetings", () => ({
  createMeeting: vi.fn(),
  listMeetings: vi.fn(),
  updateMeeting: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import { createMeeting, listMeetings, updateMeeting } from "@/lib/admissions/meetings";
import { GET, PATCH, POST } from "../route";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const MEETING_ID = "33333333-3333-4333-8333-333333333333";

const COUNSELOR_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "counselor@example.com",
  role: "counselor",
  isAdmin: false,
};

const MEETING_DTO = {
  id: MEETING_ID,
  caseId: CASE_ID,
  meetingDate: "2026-07-01",
  mode: "onsite",
  attendees: ["counselor@example.com", "student@example.com"],
  notes: "Discussed essay outline",
  nextMeetingDate: "2026-07-15",
  createdAt: "2026-07-01T03:00:00.000Z",
  updatedAt: "2026-07-01T03:00:00.000Z",
};

function makeCtx(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function makeRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}/meetings`, {
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

describe("/api/admissions/cases/[caseId]/meetings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("counselor@example.com", "counselor");
    vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);
    vi.mocked(listMeetings).mockResolvedValue([MEETING_DTO]);
    vi.mocked(createMeeting).mockResolvedValue({
      meeting: MEETING_DTO,
      createdTaskIds: ["44444444-4444-4444-8444-444444444444"],
    });
    vi.mocked(updateMeeting).mockResolvedValue(MEETING_DTO);
  });

  describe("GET", () => {
    it("returns the meeting list with minRole counselor (staff-only surface, design §4)", async () => {
      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ meetings: [MEETING_DTO] });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(listMeetings).toHaveBeenCalledWith(CASE_ID);
    });

    it("denies a student reader — meeting notes never reach the student surface", async () => {
      signInAs("student@example.com", "student");
      // requireCaseAccess enforces the counselor bar for the student member.
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(listMeetings).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(401);
      expect(listMeetings).not.toHaveBeenCalled();
    });

    it("returns 403 when the session lacks /admissions page access", async () => {
      authMock.mockResolvedValue({
        user: { email: "other@example.com", name: "Other", allowedPages: ["/credit-control"] },
      });

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).not.toHaveBeenCalled();
      expect(listMeetings).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller is not a member of the case", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(listMeetings).not.toHaveBeenCalled();
    });

    it("returns 500 JSON when the lib throws", async () => {
      vi.mocked(listMeetings).mockRejectedValue(new Error("DB exploded"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
    });
  });

  describe("POST", () => {
    it("creates a meeting with action items and returns the created task ids", async () => {
      const res = await POST(
        makeRequest("POST", {
          meetingDate: "2026-07-01",
          mode: "onsite",
          attendees: ["counselor@example.com"],
          notes: "Discussed essay outline",
          nextMeetingDate: "2026-07-15",
          actionItems: [
            { title: "Draft main essay", owner: "student", dueDate: "2026-07-10" },
            { title: "Send school report", owner: "counselor", dueDate: null },
          ],
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        meeting: MEETING_DTO,
        createdTaskIds: ["44444444-4444-4444-8444-444444444444"],
      });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(createMeeting).toHaveBeenCalledWith({
        caseId: CASE_ID,
        actorEmail: "counselor@example.com",
        actorRole: "counselor",
        meetingDate: "2026-07-01",
        mode: "onsite",
        attendees: ["counselor@example.com"],
        notes: "Discussed essay outline",
        nextMeetingDate: "2026-07-15",
        actionItems: [
          { title: "Draft main essay", owner: "student", dueDate: "2026-07-10" },
          { title: "Send school report", owner: "counselor", dueDate: null },
        ],
      });
    });

    it("maps omitted optional fields to nulls for the lib", async () => {
      const res = await POST(makeRequest("POST", { meetingDate: "2026-07-01" }), makeCtx());

      expect(res.status).toBe(200);
      expect(createMeeting).toHaveBeenCalledWith({
        caseId: CASE_ID,
        actorEmail: "counselor@example.com",
        actorRole: "counselor",
        meetingDate: "2026-07-01",
        mode: null,
        attendees: undefined,
        notes: null,
        nextMeetingDate: null,
        actionItems: undefined,
      });
    });

    it("requires the counselor bar (below → 403, nothing written)", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(makeRequest("POST", { meetingDate: "2026-07-01" }), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(createMeeting).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(makeRequest("POST", { meetingDate: "2026-07-01" }), makeCtx());

      expect(res.status).toBe(401);
      expect(createMeeting).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeRequest("POST"), makeCtx());

      expect(res.status).toBe(400);
      expect(createMeeting).not.toHaveBeenCalled();
    });

    it("returns 400 for a malformed meetingDate", async () => {
      const res = await POST(makeRequest("POST", { meetingDate: "07/01/2026" }), makeCtx());

      expect(res.status).toBe(400);
      expect(createMeeting).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown action-item owner (fail-closed)", async () => {
      const res = await POST(
        makeRequest("POST", {
          meetingDate: "2026-07-01",
          actionItems: [{ title: "Do things", owner: "teacher", dueDate: null }],
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createMeeting).not.toHaveBeenCalled();
    });
  });

  describe("PATCH", () => {
    it("updates a meeting and returns the refreshed DTO", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          meetingId: MEETING_ID,
          notes: "Rescheduled",
          nextMeetingDate: null,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ meeting: MEETING_DTO });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(updateMeeting).toHaveBeenCalledWith({
        caseId: CASE_ID,
        meetingId: MEETING_ID,
        actorEmail: "counselor@example.com",
        actorRole: "counselor",
        meetingDate: undefined,
        mode: undefined,
        attendees: undefined,
        notes: "Rescheduled",
        nextMeetingDate: null,
      });
    });

    it("returns 404 when the meeting does not exist in this case", async () => {
      vi.mocked(updateMeeting).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeRequest("PATCH", { meetingId: MEETING_ID, notes: "x" }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 400 when meetingId is missing", async () => {
      const res = await PATCH(makeRequest("PATCH", { notes: "x" }), makeCtx());

      expect(res.status).toBe(400);
      expect(updateMeeting).not.toHaveBeenCalled();
    });

    it("returns 400 when meetingId is not a UUID", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { meetingId: "not-a-uuid", notes: "x" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateMeeting).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller is below counselor", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { meetingId: MEETING_ID, notes: "x" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(updateMeeting).not.toHaveBeenCalled();
    });
  });
});
