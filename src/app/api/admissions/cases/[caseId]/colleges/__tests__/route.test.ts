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
  addCollegeListItem: vi.fn(),
  listCollegesForCase: vi.fn(),
  softDeleteCollegeListItem: vi.fn(),
  updateCollegeListItem: vi.fn(),
}));
// Stub the db-backed CM-46 rollup supplied by the recommenders module.
vi.mock("@/lib/admissions/recommenders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/recommenders")>()),
  computeCollegeCompleteness: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  addCollegeListItem,
  listCollegesForCase,
  softDeleteCollegeListItem,
  updateCollegeListItem,
} from "@/lib/admissions/colleges";
import { computeCollegeCompleteness } from "@/lib/admissions/recommenders";
import { DELETE, GET, PATCH, POST } from "../route";
import type {
  AdmissionsCollegeCompleteness,
  AdmissionsCollegeListItemDto,
  AdmissionsCollegeListRowDto,
} from "@/lib/admissions/colleges";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "99999999-9999-4999-8999-999999999999";
const UNIT_ID = 110635;

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

const COLLEGE_DTO: AdmissionsCollegeListItemDto = {
  id: ITEM_ID,
  caseId: CASE_ID,
  unitId: UNIT_ID,
  instName: "University of California-Berkeley",
  city: "Berkeley",
  stateAbbr: "CA",
  country: "US",
  isManual: false,
  round: "rd",
  deadline: "2026-11-30",
  appStatus: "researching",
  category: "reach",
  aidOffered: null,
  aidNotes: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const COMPLETENESS: AdmissionsCollegeCompleteness = {
  recsAgreed: 1,
  recsSubmitted: 1,
  recsTotal: 2,
  transcriptSent: true,
  schoolReportSent: false,
  scoreSendsSent: 0,
  complete: false,
};

const ROW_DTO: AdmissionsCollegeListRowDto = {
  ...COLLEGE_DTO,
  stats: {
    dataYear: "2023-24",
    acceptanceRate: 11.4,
    totalPriceInState: 45000,
    avgNetPrice: 18000,
    gradRateBach6yr: 93,
  },
  stale: false,
  completeness: COMPLETENESS,
};

function makeCtx(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function makeRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}/colleges`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function makeDeleteRequest(itemId?: string) {
  const query = itemId === undefined ? "" : `?itemId=${itemId}`;
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/colleges${query}`,
    { method: "DELETE" },
  );
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

describe("/api/admissions/cases/[caseId]/colleges", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("counselor@example.com", "counselor");
    vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);
    vi.mocked(computeCollegeCompleteness).mockResolvedValue(
      new Map([[ITEM_ID, COMPLETENESS]]),
    );
    vi.mocked(listCollegesForCase).mockResolvedValue([ROW_DTO]);
    vi.mocked(addCollegeListItem).mockResolvedValue(COLLEGE_DTO);
    vi.mocked(updateCollegeListItem).mockResolvedValue(COLLEGE_DTO);
    vi.mocked(softDeleteCollegeListItem).mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("returns list rows with the CM-46 completeness map wired, minRole student", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ colleges: [ROW_DTO] });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(computeCollegeCompleteness).toHaveBeenCalledWith(CASE_ID);
      expect(listCollegesForCase).toHaveBeenCalledWith(CASE_ID, {
        completenessMap: new Map([[ITEM_ID, COMPLETENESS]]),
      });
    });

    it("returns 403 for a parent (below the student bar)", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("mom@example.com", CASE_ID, "student");
      expect(listCollegesForCase).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(401);
      expect(listCollegesForCase).not.toHaveBeenCalled();
    });

    it("returns 500 JSON when the lib throws", async () => {
      vi.mocked(listCollegesForCase).mockRejectedValue(new Error("DB exploded"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
    });
  });

  describe("POST", () => {
    it("adds an IPEDS college by unitId with the counselor bar", async () => {
      const res = await POST(
        makeRequest("POST", {
          unitId: UNIT_ID,
          round: "rd",
          deadline: "2026-11-30",
          category: "reach",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ college: COLLEGE_DTO });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(addCollegeListItem).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        entry: { unitId: UNIT_ID },
        round: "rd",
        deadline: "2026-11-30",
        category: "reach",
      });
    });

    it("adds a manual (non-US) college, defaults left undefined", async () => {
      const res = await POST(
        makeRequest("POST", {
          manual: { instName: "University of Toronto", country: "Canada" },
          round: "other",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(addCollegeListItem).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        entry: { manual: { instName: "University of Toronto", country: "Canada" } },
        round: "other",
        deadline: undefined,
        category: undefined,
      });
    });

    it("returns 403 for a student (below the counselor bar), nothing written", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(
        makeRequest("POST", { unitId: UNIT_ID, round: "rd" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(addCollegeListItem).not.toHaveBeenCalled();
    });

    it("returns 409 for a duplicate college on the case", async () => {
      vi.mocked(addCollegeListItem).mockRejectedValue(new Error("Conflict"));

      const res = await POST(
        makeRequest("POST", { unitId: UNIT_ID, round: "rd" }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });

    it("returns 404 for an unknown unitId", async () => {
      vi.mocked(addCollegeListItem).mockRejectedValue(new Error("NotFound"));

      const res = await POST(
        makeRequest("POST", { unitId: 424242, round: "rd" }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 400 when neither unitId nor manual is provided", async () => {
      const res = await POST(makeRequest("POST", { round: "rd" }), makeCtx());

      expect(res.status).toBe(400);
      expect(addCollegeListItem).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown round (fail-closed)", async () => {
      const res = await POST(
        makeRequest("POST", { unitId: UNIT_ID, round: "early_bird" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(addCollegeListItem).not.toHaveBeenCalled();
    });

    it("returns 400 for an empty manual instName", async () => {
      const res = await POST(
        makeRequest("POST", { manual: { instName: "   ", country: "Canada" }, round: "other" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(addCollegeListItem).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeRequest("POST"), makeCtx());

      expect(res.status).toBe(400);
      expect(addCollegeListItem).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(
        makeRequest("POST", { unitId: UNIT_ID, round: "rd" }),
        makeCtx(),
      );

      expect(res.status).toBe(401);
      expect(addCollegeListItem).not.toHaveBeenCalled();
    });
  });

  describe("PATCH", () => {
    it("updates plan fields with the expectedUpdatedAt token", async () => {
      const updated: AdmissionsCollegeListItemDto = {
        ...COLLEGE_DTO,
        round: "ea",
        appStatus: "applying",
        aidOffered: "12000.50",
      };
      vi.mocked(updateCollegeListItem).mockResolvedValue(updated);

      const res = await PATCH(
        makeRequest("PATCH", {
          itemId: ITEM_ID,
          expectedUpdatedAt: "2026-07-01T00:00:00.000Z",
          round: "ea",
          appStatus: "applying",
          aidOffered: "12000.50",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ college: updated });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(updateCollegeListItem).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        itemId: ITEM_ID,
        expectedUpdatedAt: "2026-07-01T00:00:00.000Z",
        round: "ea",
        deadline: undefined,
        appStatus: "applying",
        category: undefined,
        aidOffered: "12000.50",
        aidNotes: undefined,
      });
    });

    it("clears the deadline with an explicit null", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { itemId: ITEM_ID, deadline: null }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(updateCollegeListItem).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: ITEM_ID, deadline: null }),
      );
    });

    it("returns 409 on a stale expectedUpdatedAt (optimistic concurrency)", async () => {
      vi.mocked(updateCollegeListItem).mockRejectedValue(new Error("Conflict"));

      const res = await PATCH(
        makeRequest("PATCH", {
          itemId: ITEM_ID,
          expectedUpdatedAt: "2026-06-30T00:00:00.000Z",
          category: "match",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });

    it("returns 403 for a student (below the counselor bar)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { itemId: ITEM_ID, category: "safety" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(updateCollegeListItem).not.toHaveBeenCalled();
    });

    it("returns 404 when the item does not exist in this case", async () => {
      vi.mocked(updateCollegeListItem).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeRequest("PATCH", { itemId: ITEM_ID, category: "match" }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 400 when itemId is not a UUID", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { itemId: "not-a-uuid", category: "match" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateCollegeListItem).not.toHaveBeenCalled();
    });

    it("returns 400 for a malformed aidOffered amount", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { itemId: ITEM_ID, aidOffered: "12,000" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateCollegeListItem).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await PATCH(makeRequest("PATCH"), makeCtx());

      expect(res.status).toBe(400);
      expect(updateCollegeListItem).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("soft-deletes a list item via ?itemId= with the counselor bar", async () => {
      const res = await DELETE(makeDeleteRequest(ITEM_ID), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(softDeleteCollegeListItem).toHaveBeenCalledWith({
        access: COUNSELOR_ACCESS,
        itemId: ITEM_ID,
      });
    });

    it("returns 400 when itemId is missing", async () => {
      const res = await DELETE(makeDeleteRequest(), makeCtx());

      expect(res.status).toBe(400);
      expect(softDeleteCollegeListItem).not.toHaveBeenCalled();
    });

    it("returns 404 when the item does not exist in this case", async () => {
      vi.mocked(softDeleteCollegeListItem).mockRejectedValue(new Error("NotFound"));

      const res = await DELETE(makeDeleteRequest(ITEM_ID), makeCtx());

      expect(res.status).toBe(404);
    });

    it("returns 403 for a student (below the counselor bar)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await DELETE(makeDeleteRequest(ITEM_ID), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(softDeleteCollegeListItem).not.toHaveBeenCalled();
    });
  });
});
