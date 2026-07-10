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
// Stub only the db-backed activity operations the route calls; the exported
// Zod block schemas and hard-limit constants stay real so char-limit 400s
// are exercised against the true limits.
vi.mock("@/lib/admissions/activities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/activities")>()),
  createActivity: vi.fn(),
  listActivitiesForCase: vi.fn(),
  setCommonAppRanks: vi.fn(),
  softDeleteActivity: vi.fn(),
  updateActivity: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  COMMON_APP_DESCRIPTION_MAX_CHARS,
  COMMON_APP_POSITION_MAX_CHARS,
  createActivity,
  listActivitiesForCase,
  MAX_COMMON_APP_RANKED_ACTIVITIES,
  setCommonAppRanks,
  softDeleteActivity,
  UC_DESCRIPTION_MAX_CHARS,
  updateActivity,
} from "@/lib/admissions/activities";
import { DELETE, GET, PATCH, POST } from "../route";
import type { AdmissionsActivityDto } from "@/lib/admissions/activities";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVITY_ID = "44444444-4444-4444-8444-444444444444";

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

const ACTIVITY_DTO: AdmissionsActivityDto = {
  id: ACTIVITY_ID,
  caseId: CASE_ID,
  name: "Robotics Club",
  fullDescription: "Founded the school robotics club.",
  commonApp: {
    position: "Founder & Captain",
    organization: "School Robotics Club",
    description: "Led a 12-member team to a national final.",
    hrsWeek: 6,
    weeksYear: 30,
    grades: ["10", "11", "12"],
    timing: "school_year",
  },
  uc: {
    description: "Founded and led the robotics club.",
    category: "extracurricular_activity",
  },
  commonAppRank: 1,
  sortOrder: 0,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

/** n unique uuid-shaped ids ("00000000-0000-4000-8000-0000000000NN"). */
function makeIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
  );
}

function makeCtx(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function makeRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}/activities`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function makeDeleteRequest(activityId?: string) {
  const query = activityId === undefined ? "" : `?activityId=${activityId}`;
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/activities${query}`,
    { method: "DELETE" },
  );
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/cases/[caseId]/activities", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("student@example.com", "student");
    vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);
    vi.mocked(listActivitiesForCase).mockResolvedValue([ACTIVITY_DTO]);
    vi.mocked(createActivity).mockResolvedValue(ACTIVITY_DTO);
    vi.mocked(updateActivity).mockResolvedValue(ACTIVITY_DTO);
    vi.mocked(setCommonAppRanks).mockResolvedValue(undefined);
    vi.mocked(softDeleteActivity).mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("returns the ranked-first rows at minRole student", async () => {
      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ activities: [ACTIVITY_DTO] });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(listActivitiesForCase).toHaveBeenCalledWith(CASE_ID);
    });

    it("returns 403 for a parent (below the student bar)", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("mom@example.com", CASE_ID, "student");
      expect(listActivitiesForCase).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(401);
      expect(listActivitiesForCase).not.toHaveBeenCalled();
    });

    it("returns 500 JSON when the lib throws", async () => {
      vi.mocked(listActivitiesForCase).mockRejectedValue(new Error("DB exploded"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "Activity list failed" });
    });
  });

  describe("POST", () => {
    it("lets a student add an activity with platform blocks", async () => {
      const res = await POST(
        makeRequest("POST", {
          name: "Robotics Club",
          fullDescription: "Founded the school robotics club.",
          commonApp: ACTIVITY_DTO.commonApp,
          uc: ACTIVITY_DTO.uc,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ activity: ACTIVITY_DTO });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(createActivity).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        name: "Robotics Club",
        fullDescription: "Founded the school robotics club.",
        commonApp: ACTIVITY_DTO.commonApp,
        uc: ACTIVITY_DTO.uc,
        sortOrder: undefined,
      });
    });

    it("lets a counselor add an activity (attributed override, §2.4)", async () => {
      signInAs("counselor@example.com", "counselor");
      vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);

      const res = await POST(makeRequest("POST", { name: "Debate Team" }), makeCtx());

      expect(res.status).toBe(200);
      expect(createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ access: COUNSELOR_ACCESS, name: "Debate Team" }),
      );
    });

    it("returns 400 when the Common App description exceeds its hard cap", async () => {
      const res = await POST(
        makeRequest("POST", {
          name: "Robotics Club",
          commonApp: { description: "x".repeat(COMMON_APP_DESCRIPTION_MAX_CHARS + 1) },
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createActivity).not.toHaveBeenCalled();
    });

    it("returns 400 when the UC description exceeds its hard cap", async () => {
      const res = await POST(
        makeRequest("POST", {
          name: "Robotics Club",
          uc: { description: "x".repeat(UC_DESCRIPTION_MAX_CHARS + 1) },
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createActivity).not.toHaveBeenCalled();
    });

    it("returns 400 for duplicate Common App grade levels", async () => {
      const res = await POST(
        makeRequest("POST", {
          name: "Robotics Club",
          commonApp: { grades: ["11", "11"] },
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createActivity).not.toHaveBeenCalled();
    });

    it("returns 400 for an empty name", async () => {
      const res = await POST(makeRequest("POST", { name: "   " }), makeCtx());

      expect(res.status).toBe(400);
      expect(createActivity).not.toHaveBeenCalled();
    });

    it("returns 409 when the case is at the live-activity cap", async () => {
      vi.mocked(createActivity).mockRejectedValue(new Error("Conflict"));

      const res = await POST(makeRequest("POST", { name: "One Too Many" }), makeCtx());

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });

    it("returns 403 for a parent, nothing written", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(makeRequest("POST", { name: "Robotics Club" }), makeCtx());

      expect(res.status).toBe(403);
      expect(createActivity).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeRequest("POST"), makeCtx());

      expect(res.status).toBe(400);
      expect(createActivity).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(makeRequest("POST", { name: "Robotics Club" }), makeCtx());

      expect(res.status).toBe(401);
      expect(createActivity).not.toHaveBeenCalled();
    });
  });

  describe("PATCH", () => {
    it('routes action "update" to updateActivity with the parsed fields', async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          action: "update",
          activityId: ACTIVITY_ID,
          expectedUpdatedAt: "2026-07-01T00:00:00.000Z",
          name: "Robotics Team",
          uc: null,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ activity: ACTIVITY_DTO });
      expect(updateActivity).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        activityId: ACTIVITY_ID,
        expectedUpdatedAt: "2026-07-01T00:00:00.000Z",
        name: "Robotics Team",
        fullDescription: undefined,
        commonApp: undefined,
        uc: null,
        sortOrder: undefined,
      });
      expect(setCommonAppRanks).not.toHaveBeenCalled();
    });

    it('routes action "rank" to setCommonAppRanks (CM-71)', async () => {
      const orderedIds = makeIds(3);

      const res = await PATCH(makeRequest("PATCH", { action: "rank", orderedIds }), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(setCommonAppRanks).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        orderedIds,
      });
      expect(updateActivity).not.toHaveBeenCalled();
    });

    it("returns 400 when the rank list exceeds the top-10 cap", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          action: "rank",
          orderedIds: makeIds(MAX_COMMON_APP_RANKED_ACTIVITIES + 1),
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(setCommonAppRanks).not.toHaveBeenCalled();
    });

    it("returns 400 for duplicate ids in the rank list", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "rank", orderedIds: [ACTIVITY_ID, ACTIVITY_ID] }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(setCommonAppRanks).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-UUID id in the rank list", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "rank", orderedIds: ["not-a-uuid"] }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(setCommonAppRanks).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown action (discriminated union)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "promote", activityId: ACTIVITY_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateActivity).not.toHaveBeenCalled();
      expect(setCommonAppRanks).not.toHaveBeenCalled();
    });

    it("returns 400 when the action is missing", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { activityId: ACTIVITY_ID, name: "Robotics Team" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateActivity).not.toHaveBeenCalled();
    });

    it("returns 400 when an update block exceeds a hard char cap", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          action: "update",
          activityId: ACTIVITY_ID,
          commonApp: { position: "x".repeat(COMMON_APP_POSITION_MAX_CHARS + 1) },
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateActivity).not.toHaveBeenCalled();
    });

    it("returns 409 on a stale expectedUpdatedAt (optimistic concurrency)", async () => {
      vi.mocked(updateActivity).mockRejectedValue(new Error("Conflict"));

      const res = await PATCH(
        makeRequest("PATCH", {
          action: "update",
          activityId: ACTIVITY_ID,
          expectedUpdatedAt: "2026-06-30T00:00:00.000Z",
          name: "Robotics Team",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });

    it("returns 404 when a ranked id is not a live activity of the case", async () => {
      vi.mocked(setCommonAppRanks).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "rank", orderedIds: [ACTIVITY_ID] }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 403 for a parent, nothing written", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "rank", orderedIds: [ACTIVITY_ID] }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(setCommonAppRanks).not.toHaveBeenCalled();
      expect(updateActivity).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await PATCH(makeRequest("PATCH"), makeCtx());

      expect(res.status).toBe(400);
      expect(updateActivity).not.toHaveBeenCalled();
      expect(setCommonAppRanks).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("lets a student soft-delete via ?activityId= (their list, §2.4)", async () => {
      const res = await DELETE(makeDeleteRequest(ACTIVITY_ID), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(softDeleteActivity).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        activityId: ACTIVITY_ID,
      });
    });

    it("returns 400 when activityId is missing", async () => {
      const res = await DELETE(makeDeleteRequest(), makeCtx());

      expect(res.status).toBe(400);
      expect(softDeleteActivity).not.toHaveBeenCalled();
    });

    it("returns 404 when the activity does not exist in this case", async () => {
      vi.mocked(softDeleteActivity).mockRejectedValue(new Error("NotFound"));

      const res = await DELETE(makeDeleteRequest(ACTIVITY_ID), makeCtx());

      expect(res.status).toBe(404);
    });

    it("returns 403 for a parent (below the student bar)", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await DELETE(makeDeleteRequest(ACTIVITY_ID), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("mom@example.com", CASE_ID, "student");
      expect(softDeleteActivity).not.toHaveBeenCalled();
    });
  });
});
