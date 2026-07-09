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
// Keep the real admissionsTaskRecurrenceSchema (the route's Zod schemas embed
// it); stub only the db-backed task operations.
vi.mock("@/lib/admissions/checklists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/checklists")>()),
  computeProgress: vi.fn(),
  createCustomTask: vi.fn(),
  listCaseTasks: vi.fn(),
  setTaskVerified: vi.fn(),
  softDeleteTask: vi.fn(),
  updateTask: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  computeProgress,
  createCustomTask,
  listCaseTasks,
  setTaskVerified,
  softDeleteTask,
  updateTask,
  updateTaskStatus,
} from "@/lib/admissions/checklists";
import { DELETE, GET, PATCH, POST } from "../route";
import type { AdmissionsTaskDto } from "@/lib/admissions/checklists";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "88888888-8888-4888-8888-888888888888";

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

const TASK_DTO: AdmissionsTaskDto = {
  id: TASK_ID,
  caseId: CASE_ID,
  templateId: null,
  templateVersion: null,
  itemKey: null,
  phase: "custom",
  title: "Draft main essay",
  description: null,
  owner: "student",
  status: "not_started",
  dueDate: null,
  verifiedByEmail: null,
  verifiedAt: null,
  recurrence: null,
  sortOrder: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const PROGRESS = { done: 1, total: 4, percent: 25, verifiedCount: 1 };

function makeCtx(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function makeRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}/tasks`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function makeDeleteRequest(taskId?: string) {
  const query = taskId === undefined ? "" : `?taskId=${taskId}`;
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/tasks${query}`,
    { method: "DELETE" },
  );
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/cases/[caseId]/tasks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("counselor@example.com", "counselor");
    vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);
    vi.mocked(listCaseTasks).mockResolvedValue([TASK_DTO]);
    vi.mocked(computeProgress).mockResolvedValue(PROGRESS);
    vi.mocked(createCustomTask).mockResolvedValue(TASK_DTO);
    vi.mocked(updateTaskStatus).mockResolvedValue(TASK_DTO);
    vi.mocked(setTaskVerified).mockResolvedValue(TASK_DTO);
    vi.mocked(updateTask).mockResolvedValue(TASK_DTO);
    vi.mocked(softDeleteTask).mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("returns the task list + progress with minRole student", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ tasks: [TASK_DTO], progress: PROGRESS });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(listCaseTasks).toHaveBeenCalledWith(CASE_ID);
      expect(computeProgress).toHaveBeenCalledWith(CASE_ID);
    });

    it("returns 403 for a parent (below the student bar)", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("mom@example.com", CASE_ID, "student");
      expect(listCaseTasks).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(401);
      expect(listCaseTasks).not.toHaveBeenCalled();
    });

    it("returns 403 when the session lacks /admissions page access", async () => {
      authMock.mockResolvedValue({
        user: { email: "other@example.com", name: "Other", allowedPages: ["/credit-control"] },
      });

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).not.toHaveBeenCalled();
    });

    it("returns 500 JSON when the lib throws", async () => {
      vi.mocked(listCaseTasks).mockRejectedValue(new Error("DB exploded"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
    });
  });

  describe("POST", () => {
    it("creates a custom task with recurrence and passes the CaseAccess", async () => {
      const res = await POST(
        makeRequest("POST", {
          title: "Weekly essay check-in",
          description: "Review essay progress",
          owner: "student",
          phase: "essays",
          dueDate: "2026-08-01",
          recurrence: { freq: "weekly", until: "2026-12-01" },
          sortOrder: 3,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ task: TASK_DTO });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(createCustomTask).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        title: "Weekly essay check-in",
        description: "Review essay progress",
        owner: "student",
        phase: "essays",
        dueDate: "2026-08-01",
        recurrence: { freq: "weekly", until: "2026-12-01" },
        sortOrder: 3,
      });
    });

    it("passes omitted optional fields through as undefined (lib defaults apply)", async () => {
      const res = await POST(
        makeRequest("POST", { title: "Send transcript", owner: "counselor" }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(createCustomTask).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        title: "Send transcript",
        description: undefined,
        owner: "counselor",
        phase: undefined,
        dueDate: undefined,
        recurrence: undefined,
        sortOrder: undefined,
      });
    });

    it("requires the counselor bar (below → 403, nothing written)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(
        makeRequest("POST", { title: "Send transcript", owner: "counselor" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(createCustomTask).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(
        makeRequest("POST", { title: "Send transcript", owner: "counselor" }),
        makeCtx(),
      );

      expect(res.status).toBe(401);
      expect(createCustomTask).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeRequest("POST"), makeCtx());

      expect(res.status).toBe(400);
      expect(createCustomTask).not.toHaveBeenCalled();
    });

    it("returns 400 for an empty title", async () => {
      const res = await POST(makeRequest("POST", { title: "   ", owner: "student" }), makeCtx());

      expect(res.status).toBe(400);
      expect(createCustomTask).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown phase (fail-closed)", async () => {
      const res = await POST(
        makeRequest("POST", { title: "Do things", owner: "student", phase: "extracurriculars" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createCustomTask).not.toHaveBeenCalled();
    });

    it("returns 400 for a malformed recurrence (fail-closed)", async () => {
      const res = await POST(
        makeRequest("POST", {
          title: "Do things",
          owner: "student",
          recurrence: { freq: "daily", until: "2026-12-01" },
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(createCustomTask).not.toHaveBeenCalled();
    });
  });

  describe("PATCH action=status", () => {
    it("lets a student tick a task, passing the student CaseAccess to the lib", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);
      const doneTask: AdmissionsTaskDto = { ...TASK_DTO, status: "done" };
      vi.mocked(updateTaskStatus).mockResolvedValue(doneTask);

      const res = await PATCH(
        makeRequest("PATCH", { action: "status", taskId: TASK_ID, status: "done" }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ task: doneTask });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(updateTaskStatus).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        taskId: TASK_ID,
        status: "done",
      });
    });

    it("returns 403 when a student ticks a counselor-owned task (lib rule)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);
      vi.mocked(updateTaskStatus).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "status", taskId: TASK_ID, status: "done" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    });

    it("returns 400 for an unknown status", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "status", taskId: TASK_ID, status: "finished" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateTaskStatus).not.toHaveBeenCalled();
    });

    it("returns 404 when the task does not exist in this case", async () => {
      vi.mocked(updateTaskStatus).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "status", taskId: TASK_ID, status: "done" }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });
  });

  describe("PATCH action=verify", () => {
    it("verifies a student-owned task as counselor", async () => {
      const verifiedTask: AdmissionsTaskDto = {
        ...TASK_DTO,
        status: "done",
        verifiedByEmail: "counselor@example.com",
        verifiedAt: "2026-07-02T00:00:00.000Z",
      };
      vi.mocked(setTaskVerified).mockResolvedValue(verifiedTask);

      const res = await PATCH(
        makeRequest("PATCH", { action: "verify", taskId: TASK_ID, verified: true }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ task: verifiedTask });
      expect(setTaskVerified).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        taskId: TASK_ID,
        verified: true,
      });
    });

    it("returns 403 when a student attempts verification (counselor+ in the lib)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);
      vi.mocked(setTaskVerified).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "verify", taskId: TASK_ID, verified: true }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(setTaskVerified).toHaveBeenCalledWith({
        access: STUDENT_ACCESS,
        taskId: TASK_ID,
        verified: true,
      });
    });

    it("returns 409 when verifying a non-student-owned task", async () => {
      vi.mocked(setTaskVerified).mockRejectedValue(new Error("Conflict"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "verify", taskId: TASK_ID, verified: true }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });
  });

  describe("PATCH action=update", () => {
    it("edits task fields as counselor", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          action: "update",
          taskId: TASK_ID,
          title: "Draft main essay v2",
          dueDate: "2026-09-01",
          recurrence: null,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ task: TASK_DTO });
      expect(updateTask).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        taskId: TASK_ID,
        title: "Draft main essay v2",
        description: undefined,
        owner: undefined,
        dueDate: "2026-09-01",
        recurrence: null,
        sortOrder: undefined,
      });
    });

    it("returns 403 when a student attempts an edit (counselor+ in the lib)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);
      vi.mocked(updateTask).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "update", taskId: TASK_ID, title: "Hijacked" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
    });

    it("returns 400 when taskId is not a UUID", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "update", taskId: "not-a-uuid", title: "x" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateTask).not.toHaveBeenCalled();
    });
  });

  describe("PATCH action=delete", () => {
    it("soft-deletes a custom task and returns ok", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "delete", taskId: TASK_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(softDeleteTask).toHaveBeenCalledWith({ access: COUNSELOR_ACCESS, taskId: TASK_ID });
    });

    it("returns 409 for a template-derived task (never deletable)", async () => {
      vi.mocked(softDeleteTask).mockRejectedValue(new Error("Conflict"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "delete", taskId: TASK_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });

    it("returns 403 when a student attempts a delete (counselor+ in the lib)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);
      vi.mocked(softDeleteTask).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "delete", taskId: TASK_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
    });
  });

  describe("PATCH (shared boundary)", () => {
    it("returns 400 for an unknown action", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "archive", taskId: TASK_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateTaskStatus).not.toHaveBeenCalled();
      expect(setTaskVerified).not.toHaveBeenCalled();
      expect(updateTask).not.toHaveBeenCalled();
      expect(softDeleteTask).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await PATCH(makeRequest("PATCH"), makeCtx());

      expect(res.status).toBe(400);
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await PATCH(
        makeRequest("PATCH", { action: "status", taskId: TASK_ID, status: "done" }),
        makeCtx(),
      );

      expect(res.status).toBe(401);
      expect(updateTaskStatus).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller is not a member of the case", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "status", taskId: TASK_ID, status: "done" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(updateTaskStatus).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("soft-deletes a custom task via ?taskId= with the counselor bar", async () => {
      const res = await DELETE(makeDeleteRequest(TASK_ID), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(softDeleteTask).toHaveBeenCalledWith({ access: COUNSELOR_ACCESS, taskId: TASK_ID });
    });

    it("returns 409 for a template-derived task (never deletable)", async () => {
      vi.mocked(softDeleteTask).mockRejectedValue(new Error("Conflict"));

      const res = await DELETE(makeDeleteRequest(TASK_ID), makeCtx());

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });

    it("returns 400 when taskId is missing", async () => {
      const res = await DELETE(makeDeleteRequest(), makeCtx());

      expect(res.status).toBe(400);
      expect(softDeleteTask).not.toHaveBeenCalled();
    });

    it("returns 400 when taskId is not a UUID", async () => {
      const res = await DELETE(makeDeleteRequest("not-a-uuid"), makeCtx());

      expect(res.status).toBe(400);
      expect(softDeleteTask).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller is below counselor", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await DELETE(makeDeleteRequest(TASK_ID), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(softDeleteTask).not.toHaveBeenCalled();
    });
  });
});
