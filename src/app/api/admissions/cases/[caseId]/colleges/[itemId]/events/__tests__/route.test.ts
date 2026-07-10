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
// Stub only the db-backed college operations the route calls.
vi.mock("@/lib/admissions/colleges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/colleges")>()),
  addApplicationEvent: vi.fn(),
  listApplicationEvents: vi.fn(),
  listCollegesForCase: vi.fn(),
  setCommittedCollege: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  addApplicationEvent,
  listApplicationEvents,
  listCollegesForCase,
  setCommittedCollege,
} from "@/lib/admissions/colleges";
import { GET, POST } from "../route";
import type {
  AdmissionsApplicationEventDto,
  AdmissionsCollegeListRowDto,
  CommittedCollegeResult,
} from "@/lib/admissions/colleges";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "99999999-9999-4999-8999-999999999999";
const EVENT_ID = "77777777-7777-4777-8777-777777777777";

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

const EVENT_DTO: AdmissionsApplicationEventDto = {
  id: EVENT_ID,
  listItemId: ITEM_ID,
  event: "submitted",
  eventDate: "2026-11-01",
  notes: null,
  createdAt: "2026-11-01T00:00:00.000Z",
};

const COMMITTED_RESULT: CommittedCollegeResult = {
  caseId: CASE_ID,
  committedListItemId: ITEM_ID,
  updatedAt: "2027-05-01T00:00:00.000Z",
};

const ROW_DTO: AdmissionsCollegeListRowDto = {
  id: ITEM_ID,
  caseId: CASE_ID,
  unitId: 110635,
  instName: "University of California-Berkeley",
  city: "Berkeley",
  stateAbbr: "CA",
  country: "US",
  isManual: false,
  round: "rd",
  deadline: "2026-11-30",
  appStatus: "submitted",
  category: "reach",
  firstChoiceMajor: null,
  secondChoiceMajor: null,
  admissionsUrl: null,
  portalUrl: null,
  aidOffered: null,
  aidNotes: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  stats: null,
  stale: false,
  completeness: null,
};

function makeCtx(caseId: string = CASE_ID, itemId: string = ITEM_ID) {
  return { params: Promise.resolve({ caseId, itemId }) };
}

function makePostRequest(body?: unknown) {
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/colleges/${ITEM_ID}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/cases/[caseId]/colleges/[itemId]/events", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("counselor@example.com", "counselor");
    vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);
    vi.mocked(listCollegesForCase).mockResolvedValue([ROW_DTO]);
    vi.mocked(listApplicationEvents).mockResolvedValue([EVENT_DTO]);
    vi.mocked(addApplicationEvent).mockResolvedValue(EVENT_DTO);
    vi.mocked(setCommittedCollege).mockResolvedValue(COMMITTED_RESULT);
  });

  describe("GET", () => {
    it("returns the decision chain with minRole student after the ownership check", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ events: [EVENT_DTO] });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(listCollegesForCase).toHaveBeenCalledWith(CASE_ID);
      expect(listApplicationEvents).toHaveBeenCalledWith(ITEM_ID);
    });

    it("returns 403 for a parent (below the student bar)", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("mom@example.com", CASE_ID, "student");
      expect(listApplicationEvents).not.toHaveBeenCalled();
    });

    it("returns 404 when the item is not one of this case's rows (cross-case probe)", async () => {
      vi.mocked(listCollegesForCase).mockResolvedValue([]);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
      expect(listApplicationEvents).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(401);
      expect(listApplicationEvents).not.toHaveBeenCalled();
    });

    it("returns 500 JSON when the lib throws", async () => {
      vi.mocked(listApplicationEvents).mockRejectedValue(new Error("DB exploded"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "Event list failed" });
    });
  });

  describe("POST", () => {
    it("appends a dated decision event with the counselor bar", async () => {
      const deferred: AdmissionsApplicationEventDto = {
        ...EVENT_DTO,
        event: "deferred",
        eventDate: "2026-12-15",
        notes: "Deferred to RD",
      };
      vi.mocked(addApplicationEvent).mockResolvedValue(deferred);

      const res = await POST(
        makePostRequest({ event: "deferred", eventDate: "2026-12-15", notes: "Deferred to RD" }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ event: deferred });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(addApplicationEvent).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        listItemId: ITEM_ID,
        event: "deferred",
        eventDate: "2026-12-15",
        notes: "Deferred to RD",
      });
      expect(setCommittedCollege).not.toHaveBeenCalled();
    });

    it("routes a committed event through setCommittedCollege (CM-44 canonical path)", async () => {
      const res = await POST(
        makePostRequest({ event: "committed", eventDate: "2027-05-01" }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ committed: COMMITTED_RESULT });
      expect(setCommittedCollege).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        listItemId: ITEM_ID,
        eventDate: "2027-05-01",
      });
      expect(addApplicationEvent).not.toHaveBeenCalled();
    });

    it("returns 409 when another item already holds the committed pointer", async () => {
      vi.mocked(setCommittedCollege).mockRejectedValue(new Error("Conflict"));

      const res = await POST(
        makePostRequest({ event: "committed", eventDate: "2027-05-01" }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
      expect(addApplicationEvent).not.toHaveBeenCalled();
    });

    it("maps a lib Conflict to 409 on the append path", async () => {
      vi.mocked(addApplicationEvent).mockRejectedValue(new Error("Conflict"));

      const res = await POST(
        makePostRequest({ event: "accepted", eventDate: "2027-03-30" }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
    });

    it("returns 403 for a student (below the counselor bar), nothing written", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(
        makePostRequest({ event: "submitted", eventDate: "2026-11-01" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(addApplicationEvent).not.toHaveBeenCalled();
      expect(setCommittedCollege).not.toHaveBeenCalled();
    });

    it("returns 404 when the item does not exist in this case", async () => {
      vi.mocked(addApplicationEvent).mockRejectedValue(new Error("NotFound"));

      const res = await POST(
        makePostRequest({ event: "submitted", eventDate: "2026-11-01" }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 400 for an unknown event (fail-closed)", async () => {
      const res = await POST(
        makePostRequest({ event: "enrolled", eventDate: "2027-05-01" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(addApplicationEvent).not.toHaveBeenCalled();
      expect(setCommittedCollege).not.toHaveBeenCalled();
    });

    it("returns 400 for a malformed eventDate", async () => {
      const res = await POST(
        makePostRequest({ event: "submitted", eventDate: "01/11/2026" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(addApplicationEvent).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makePostRequest(), makeCtx());

      expect(res.status).toBe(400);
      expect(addApplicationEvent).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(
        makePostRequest({ event: "submitted", eventDate: "2026-11-01" }),
        makeCtx(),
      );

      expect(res.status).toBe(401);
      expect(addApplicationEvent).not.toHaveBeenCalled();
    });
  });
});
