import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/progress-tests/service", () => ({
  getProgressTestsPayload: vi.fn(),
  bookTest: vi.fn(),
  markComplete: vi.fn(),
  resendTeacherEmail: vi.fn(),
}));
vi.mock("@/lib/progress-tests/teacher-access", () => ({
  resolveTeacherCanonicalKeys: vi.fn(),
}));

import { auth } from "@/lib/auth";
import {
  getProgressTestsPayload,
  bookTest,
  markComplete,
  resendTeacherEmail,
} from "@/lib/progress-tests/service";
import { resolveTeacherCanonicalKeys } from "@/lib/progress-tests/teacher-access";
import { GET } from "@/app/api/progress-tests/route";
import { POST as bookRoute } from "@/app/api/progress-tests/book/route";
import { POST as markCompleteRoute } from "@/app/api/progress-tests/mark-complete/route";
import { POST as resendEmailRoute } from "@/app/api/progress-tests/resend-email/route";

const authMock = auth as unknown as Mock;

const payload = {
  rows: [],
  summary: { accumulating: 0, approaching: 0, due: 0, scheduled: 0, completed: 0, total: 0 },
  subjects: [],
  lastSyncedAt: null,
  generatedAt: "2026-06-04T00:00:00.000Z",
};

const sampleRow = {
  enrollmentKey: "class-1|student-1",
  wiseStudentId: "student-1",
  wiseClassId: "class-1",
  studentKey: "ada::parent",
  studentName: "Ada Lovelace",
  parentName: "parent",
  subject: "Math",
  currentCount: 8,
  threshold: 8,
  cycleIndex: 0,
  status: "scheduled",
  mostFrequentTutorCanonicalKey: "alice",
  mostFrequentTutorDisplayName: "Alice",
  teacherNotifiedAt: null,
  teacherNotifiedForCycle: null,
  bookedTestWiseSessionId: null,
  bookedTestDate: "2026-06-20T02:00:00.000Z",
  bookedTestBookingMode: "manual",
  lastClassDate: null,
  lastAiSummary: null,
  lastAiSummaryAt: null,
  updatedByEmail: "admin@example.com",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

function postRequest(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("progress-tests API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin", allowedPages: null } });
    vi.mocked(getProgressTestsPayload).mockResolvedValue(payload as never);
    vi.mocked(bookTest).mockResolvedValue({
      status: "manual_required",
      wiseSessionId: null,
      bookingMode: "manual",
      message: "recorded locally",
      row: sampleRow,
    } as never);
    vi.mocked(markComplete).mockResolvedValue(sampleRow as never);
    vi.mocked(resendTeacherEmail).mockResolvedValue({
      outcome: { enrollmentKey: "class-1|student-1", cycleIndex: 0, status: "sent", recipientEmail: "a@b.com", error: null },
      row: sampleRow,
    } as never);
  });

  describe("GET /api/progress-tests", () => {
    it("returns the dashboard payload for an authorized session", async () => {
      const res = await GET();

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        summary: { total: 0 },
        subjects: [],
        lastSyncedAt: null,
      });
    });

    it("scopes the payload to a teacher's canonicalKeys", async () => {
      authMock.mockResolvedValue({
        user: { email: "aey@example.com", name: "Aey", allowedPages: ["/progress-tests"], role: "teacher" },
      });
      vi.mocked(resolveTeacherCanonicalKeys).mockResolvedValue(["Aey"]);

      const res = await GET();

      expect(res.status).toBe(200);
      expect(resolveTeacherCanonicalKeys).toHaveBeenCalledWith("aey@example.com");
      expect(getProgressTestsPayload).toHaveBeenCalledWith({ teacherCanonicalKeys: ["Aey"] });
    });

    it("passes no teacher filter for an admin session", async () => {
      const res = await GET();

      expect(res.status).toBe(200);
      expect(getProgressTestsPayload).toHaveBeenCalledWith({ teacherCanonicalKeys: null });
      expect(resolveTeacherCanonicalKeys).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET();

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
      expect(getProgressTestsPayload).not.toHaveBeenCalled();
    });

    it("returns 403 when the session lacks page access", async () => {
      authMock.mockResolvedValue({ user: { email: "other@example.com", name: "Other", allowedPages: ["/credit-control"] } });

      const res = await GET();

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
      expect(getProgressTestsPayload).not.toHaveBeenCalled();
    });

    it("returns 500 JSON when the service throws", async () => {
      vi.mocked(getProgressTestsPayload).mockRejectedValue(new Error("DB exploded") as never);

      const res = await GET();

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
    });
  });

  describe("POST /api/progress-tests/book", () => {
    it("returns 403 for a teacher session (read-only)", async () => {
      authMock.mockResolvedValue({
        user: { email: "aey@example.com", name: "Aey", allowedPages: ["/progress-tests"], role: "teacher" },
      });

      const res = await bookRoute(postRequest("http://test.local/api/progress-tests/book", {
        enrollmentKey: "class-1|student-1",
        testDate: "2026-06-20T02:00:00.000Z",
      }));

      expect(res.status).toBe(403);
      expect(bookTest).not.toHaveBeenCalled();
    });

    it("books a test and returns the refreshed row", async () => {
      const res = await bookRoute(postRequest("http://test.local/api/progress-tests/book", {
        enrollmentKey: "class-1|student-1",
        testDate: "2026-06-20T02:00:00.000Z",
        location: "Tesla",
      }));

      expect(res.status).toBe(200);
      expect(bookTest).toHaveBeenCalledWith({
        enrollmentKey: "class-1|student-1",
        testDate: new Date("2026-06-20T02:00:00.000Z"),
        location: "Tesla",
        scheduleMethod: "parent_pick",
        actor: { email: "admin@example.com", name: "Admin", role: "admin" },
      });
      await expect(res.json()).resolves.toMatchObject({ status: "manual_required", row: { enrollmentKey: "class-1|student-1" } });
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await bookRoute(postRequest("http://test.local/api/progress-tests/book", {
        enrollmentKey: "class-1|student-1",
        testDate: "2026-06-20T02:00:00.000Z",
      }));

      expect(res.status).toBe(401);
      expect(bookTest).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid body", async () => {
      const res = await bookRoute(postRequest("http://test.local/api/progress-tests/book", {
        enrollmentKey: "",
        testDate: "not-a-date",
      }));

      expect(res.status).toBe(400);
      expect(bookTest).not.toHaveBeenCalled();
    });

    it("returns 404 when the enrollment is unknown", async () => {
      vi.mocked(bookTest).mockResolvedValue({
        status: "manual_required",
        wiseSessionId: null,
        bookingMode: "manual",
        message: "recorded",
        row: null,
      } as never);

      const res = await bookRoute(postRequest("http://test.local/api/progress-tests/book", {
        enrollmentKey: "missing|student",
        testDate: "2026-06-20T02:00:00.000Z",
      }));

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/progress-tests/mark-complete", () => {
    it("marks complete and returns the refreshed row", async () => {
      const res = await markCompleteRoute(postRequest("http://test.local/api/progress-tests/mark-complete", {
        enrollmentKey: "class-1|student-1",
      }));

      expect(res.status).toBe(200);
      expect(markComplete).toHaveBeenCalledWith({
        enrollmentKey: "class-1|student-1",
        actor: { email: "admin@example.com", name: "Admin", role: "admin" },
      });
      await expect(res.json()).resolves.toEqual({ row: sampleRow });
    });

    it("returns 404 when the enrollment has no cycle state", async () => {
      vi.mocked(markComplete).mockResolvedValue(null as never);

      const res = await markCompleteRoute(postRequest("http://test.local/api/progress-tests/mark-complete", {
        enrollmentKey: "missing|student",
      }));

      expect(res.status).toBe(404);
    });

    it("returns 400 for an invalid body", async () => {
      const res = await markCompleteRoute(postRequest("http://test.local/api/progress-tests/mark-complete", {}));

      expect(res.status).toBe(400);
      expect(markComplete).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/progress-tests/resend-email", () => {
    it("resends the heads-up email and returns the outcome", async () => {
      const res = await resendEmailRoute(postRequest("http://test.local/api/progress-tests/resend-email", {
        enrollmentKey: "class-1|student-1",
      }));

      expect(res.status).toBe(200);
      expect(resendTeacherEmail).toHaveBeenCalledWith({
        enrollmentKey: "class-1|student-1",
        actor: { email: "admin@example.com", name: "Admin", role: "admin" },
      });
      await expect(res.json()).resolves.toMatchObject({ outcome: { status: "sent" }, row: { enrollmentKey: "class-1|student-1" } });
    });

    it("returns 404 when the enrollment is unknown", async () => {
      vi.mocked(resendTeacherEmail).mockResolvedValue({ outcome: null, row: null } as never);

      const res = await resendEmailRoute(postRequest("http://test.local/api/progress-tests/resend-email", {
        enrollmentKey: "missing|student",
      }));

      expect(res.status).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await resendEmailRoute(postRequest("http://test.local/api/progress-tests/resend-email", {
        enrollmentKey: "class-1|student-1",
      }));

      expect(res.status).toBe(401);
      expect(resendTeacherEmail).not.toHaveBeenCalled();
    });
  });
});
