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
// Keep the real limit constants; mock only the db-backed aggregation fns.
vi.mock("@/lib/admissions/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/calendar")>()),
  buildCaseCalendar: vi.fn(),
  getUpcomingDeadlines: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  buildCaseCalendar,
  getUpcomingDeadlines,
  UPCOMING_DEADLINES_DEFAULT_LIMIT,
} from "@/lib/admissions/calendar";
import { GET } from "../route";
import type { CalendarItem } from "@/lib/admissions/calendar";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

const STUDENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "student@example.com",
  role: "student",
  isAdmin: false,
};

const CALENDAR_ITEM: CalendarItem = {
  id: TASK_ID,
  caseId: CASE_ID,
  source: "task",
  title: "Draft main essay",
  date: "2026-07-10",
  overdue: false,
  ownerRole: "student",
};

const UPCOMING_ITEM: CalendarItem = {
  ...CALENDAR_ITEM,
  date: "2026-07-05",
  overdue: true,
};

function makeCtx(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function makeRequest(query: string) {
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/calendar${query}`,
  );
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/cases/[caseId]/calendar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("student@example.com", "student");
    vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);
    vi.mocked(buildCaseCalendar).mockResolvedValue([CALENDAR_ITEM]);
    vi.mocked(getUpcomingDeadlines).mockResolvedValue([UPCOMING_ITEM]);
  });

  describe("GET", () => {
    it("returns the window items and upcoming list with minRole student", async () => {
      const res = await GET(makeRequest("?from=2026-07-01&to=2026-07-31"), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        items: [CALENDAR_ITEM],
        upcoming: [UPCOMING_ITEM],
      });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(buildCaseCalendar).toHaveBeenCalledWith(CASE_ID, {
        from: "2026-07-01",
        to: "2026-07-31",
      });
      expect(getUpcomingDeadlines).toHaveBeenCalledWith(
        CASE_ID,
        UPCOMING_DEADLINES_DEFAULT_LIMIT,
      );
    });

    it("coerces ?limit= onto the upcoming-deadlines call", async () => {
      const res = await GET(
        makeRequest("?from=2026-07-01&to=2026-07-31&limit=3"),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(getUpcomingDeadlines).toHaveBeenCalledWith(CASE_ID, 3);
    });

    it("returns 400 for a non-numeric limit", async () => {
      const res = await GET(
        makeRequest("?from=2026-07-01&to=2026-07-31&limit=abc"),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(buildCaseCalendar).not.toHaveBeenCalled();
      expect(getUpcomingDeadlines).not.toHaveBeenCalled();
    });

    it("returns 400 for an out-of-range limit", async () => {
      for (const limit of ["0", "101", "2.5"]) {
        const res = await GET(
          makeRequest(`?from=2026-07-01&to=2026-07-31&limit=${limit}`),
          makeCtx(),
        );
        expect(res.status).toBe(400);
      }
      expect(buildCaseCalendar).not.toHaveBeenCalled();
    });

    it("returns 400 when from is missing", async () => {
      const res = await GET(makeRequest("?to=2026-07-31"), makeCtx());

      expect(res.status).toBe(400);
      expect(buildCaseCalendar).not.toHaveBeenCalled();
    });

    it("returns 400 when to is missing", async () => {
      const res = await GET(makeRequest("?from=2026-07-01"), makeCtx());

      expect(res.status).toBe(400);
      expect(buildCaseCalendar).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-date-only window bound", async () => {
      for (const query of [
        "?from=07/01/2026&to=2026-07-31",
        "?from=2026-07-01&to=2026-07-31T00:00:00Z",
      ]) {
        const res = await GET(makeRequest(query), makeCtx());
        expect(res.status).toBe(400);
      }
      expect(buildCaseCalendar).not.toHaveBeenCalled();
    });

    it("returns 400 when from is after to", async () => {
      const res = await GET(makeRequest("?from=2026-08-01&to=2026-07-31"), makeCtx());

      expect(res.status).toBe(400);
      expect(buildCaseCalendar).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(makeRequest("?from=2026-07-01&to=2026-07-31"), makeCtx());

      expect(res.status).toBe(401);
      expect(requireCaseAccess).not.toHaveBeenCalled();
      expect(buildCaseCalendar).not.toHaveBeenCalled();
    });

    it("returns 403 when the session lacks /admissions page access", async () => {
      authMock.mockResolvedValue({
        user: { email: "other@example.com", name: "Other", allowedPages: ["/credit-control"] },
      });

      const res = await GET(makeRequest("?from=2026-07-01&to=2026-07-31"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller is below the student bar (parents excluded)", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(makeRequest("?from=2026-07-01&to=2026-07-31"), makeCtx());

      expect(res.status).toBe(403);
      expect(buildCaseCalendar).not.toHaveBeenCalled();
    });

    it("returns 404 for an admin when the case does not exist", async () => {
      signInAs("admin@example.com", "admin");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("NotFound"));

      const res = await GET(makeRequest("?from=2026-07-01&to=2026-07-31"), makeCtx());

      expect(res.status).toBe(404);
      expect(buildCaseCalendar).not.toHaveBeenCalled();
    });

    it("runs the access check before query validation (bad window never reaches a non-member)", async () => {
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(makeRequest("?from=bogus"), makeCtx());

      expect(res.status).toBe(403);
    });

    it("returns 500 JSON when the lib throws", async () => {
      vi.mocked(buildCaseCalendar).mockRejectedValue(new Error("DB exploded"));

      const res = await GET(makeRequest("?from=2026-07-01&to=2026-07-31"), makeCtx());

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
    });
  });
});
