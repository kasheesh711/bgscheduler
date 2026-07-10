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
// The route only consumes db-backed functions from these modules (its Zod
// enums mirror the lib constants), so plain factory stubs suffice.
vi.mock("@/lib/admissions/recommenders", () => ({
  createRecommender: vi.fn(),
  linkRecommenderToCollege: vi.fn(),
  listCollegeDocs: vi.fn(),
  listRecommenders: vi.fn(),
  setCollegeDoc: vi.fn(),
  setRecommenderSubmission: vi.fn(),
  softDeleteRecommender: vi.fn(),
  updateRecommender: vi.fn(),
}));
vi.mock("@/lib/admissions/colleges", () => ({
  listCollegesForCase: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import { listCollegesForCase } from "@/lib/admissions/colleges";
import {
  createRecommender,
  linkRecommenderToCollege,
  listCollegeDocs,
  listRecommenders,
  setCollegeDoc,
  setRecommenderSubmission,
  softDeleteRecommender,
  updateRecommender,
} from "@/lib/admissions/recommenders";
import { DELETE, GET, PATCH, POST } from "../route";
import type { AdmissionsCollegeListRowDto } from "@/lib/admissions/colleges";
import type {
  AdmissionsCollegeDocDto,
  AdmissionsRecommenderCollegeDto,
  AdmissionsRecommenderDto,
  AdmissionsRecommenderWithCollegesDto,
} from "@/lib/admissions/recommenders";
import type { CaseAccess } from "@/lib/admissions/types";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const REC_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const LINK_ID = "44444444-4444-4444-8444-444444444444";
const DOC_ID = "55555555-5555-4555-8555-555555555555";
const SITTING_ID = "66666666-6666-4666-8666-666666666666";

const COUNSELOR_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "counselor@example.com",
  role: "counselor",
  isAdmin: false,
};

const ADMIN_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "admin@example.com",
  role: "admin",
  isAdmin: true,
};

const STUDENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "student@example.com",
  role: "student",
  isAdmin: false,
};

const COUNSELOR_ACTOR = { email: "counselor@example.com", role: "counselor" };

const RECOMMENDER_DTO: AdmissionsRecommenderDto = {
  id: REC_ID,
  caseId: CASE_ID,
  name: "Dr. Smith",
  roleSubject: "Physics teacher",
  contact: "smith@school.edu",
  askStatus: "planned",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const LINK_DTO: AdmissionsRecommenderCollegeDto = {
  id: LINK_ID,
  recommenderId: REC_ID,
  listItemId: ITEM_ID,
  submitted: false,
  submittedAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const RECOMMENDER_WITH_COLLEGES: AdmissionsRecommenderWithCollegesDto = {
  ...RECOMMENDER_DTO,
  colleges: [LINK_DTO],
};

const DOC_DTO: AdmissionsCollegeDocDto = {
  id: DOC_ID,
  listItemId: ITEM_ID,
  docType: "transcript",
  testSittingId: null,
  sent: true,
  sentAt: "2026-07-02T00:00:00.000Z",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
};

const COLLEGE_ROW_DTO: AdmissionsCollegeListRowDto = {
  id: ITEM_ID,
  caseId: CASE_ID,
  unitId: 166027,
  instName: "Harvard University",
  city: "Cambridge",
  stateAbbr: "MA",
  country: "US",
  isManual: false,
  round: "rd",
  deadline: "2027-01-01",
  appStatus: "applying",
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

function makeCtx(caseId: string = CASE_ID) {
  return { params: Promise.resolve({ caseId }) };
}

function makeRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/recommenders`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

function makeDeleteRequest(recommenderId?: string) {
  const query = recommenderId === undefined ? "" : `?recommenderId=${recommenderId}`;
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}/recommenders${query}`,
    { method: "DELETE" },
  );
}

function signInAs(email: string, role: string) {
  authMock.mockResolvedValue({
    user: { email, name: "Test User", allowedPages: ["/admissions"], role },
  });
}

function expectNoMutations() {
  expect(createRecommender).not.toHaveBeenCalled();
  expect(updateRecommender).not.toHaveBeenCalled();
  expect(linkRecommenderToCollege).not.toHaveBeenCalled();
  expect(setRecommenderSubmission).not.toHaveBeenCalled();
  expect(setCollegeDoc).not.toHaveBeenCalled();
  expect(softDeleteRecommender).not.toHaveBeenCalled();
}

describe("/api/admissions/cases/[caseId]/recommenders", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAs("counselor@example.com", "counselor");
    vi.mocked(requireCaseAccess).mockResolvedValue(COUNSELOR_ACCESS);
    vi.mocked(listRecommenders).mockResolvedValue([RECOMMENDER_WITH_COLLEGES]);
    vi.mocked(listCollegeDocs).mockResolvedValue([DOC_DTO]);
    vi.mocked(listCollegesForCase).mockResolvedValue([COLLEGE_ROW_DTO]);
    vi.mocked(createRecommender).mockResolvedValue(RECOMMENDER_DTO);
    vi.mocked(updateRecommender).mockResolvedValue(RECOMMENDER_DTO);
    vi.mocked(softDeleteRecommender).mockResolvedValue(undefined);
    vi.mocked(linkRecommenderToCollege).mockResolvedValue(LINK_DTO);
    vi.mocked(setRecommenderSubmission).mockResolvedValue(LINK_DTO);
    vi.mocked(setCollegeDoc).mockResolvedValue(DOC_DTO);
  });

  describe("GET", () => {
    it("returns recommenders + college docs with minRole student", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockResolvedValue(STUDENT_ACCESS);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        recommenders: [RECOMMENDER_WITH_COLLEGES],
        collegeDocs: [DOC_DTO],
      });
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "student");
      expect(listRecommenders).toHaveBeenCalledWith(CASE_ID);
      expect(listCollegeDocs).toHaveBeenCalledWith(CASE_ID);
    });

    it("returns 403 for a parent (below the student bar)", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("mom@example.com", CASE_ID, "student");
      expect(listRecommenders).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(401);
      expect(listRecommenders).not.toHaveBeenCalled();
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
      vi.mocked(listRecommenders).mockRejectedValue(new Error("DB exploded"));

      const res = await GET(new Request("http://test.local"), makeCtx());

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "Recommender list failed" });
    });
  });

  describe("POST", () => {
    it("creates a recommender with the counselor bar and passes the actor", async () => {
      const res = await POST(
        makeRequest("POST", {
          name: "Dr. Smith",
          roleSubject: "Physics teacher",
          contact: "smith@school.edu",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ recommender: RECOMMENDER_DTO });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(createRecommender).toHaveBeenCalledWith(
        CASE_ID,
        { name: "Dr. Smith", roleSubject: "Physics teacher", contact: "smith@school.edu" },
        COUNSELOR_ACTOR,
      );
    });

    it("passes omitted optional fields through as undefined (lib defaults apply)", async () => {
      const res = await POST(makeRequest("POST", { name: "Coach Lee" }), makeCtx());

      expect(res.status).toBe(200);
      expect(createRecommender).toHaveBeenCalledWith(
        CASE_ID,
        { name: "Coach Lee", roleSubject: undefined, contact: undefined },
        COUNSELOR_ACTOR,
      );
    });

    it("returns 403 for a student (below the counselor bar)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await POST(makeRequest("POST", { name: "Dr. Smith" }), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(createRecommender).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await POST(makeRequest("POST", { name: "Dr. Smith" }), makeCtx());

      expect(res.status).toBe(401);
      expect(createRecommender).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await POST(makeRequest("POST"), makeCtx());

      expect(res.status).toBe(400);
      expect(createRecommender).not.toHaveBeenCalled();
    });

    it("returns 400 for an empty name", async () => {
      const res = await POST(makeRequest("POST", { name: "   " }), makeCtx());

      expect(res.status).toBe(400);
      expect(createRecommender).not.toHaveBeenCalled();
    });
  });

  describe("PATCH action=update", () => {
    it("updates fields + askStatus as counselor", async () => {
      const asked: AdmissionsRecommenderDto = { ...RECOMMENDER_DTO, askStatus: "asked" };
      vi.mocked(updateRecommender).mockResolvedValue(asked);

      const res = await PATCH(
        makeRequest("PATCH", {
          action: "update",
          recommenderId: REC_ID,
          name: "Dr. Jane Smith",
          askStatus: "asked",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ recommender: asked });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(updateRecommender).toHaveBeenCalledWith(
        CASE_ID,
        REC_ID,
        {
          name: "Dr. Jane Smith",
          roleSubject: undefined,
          contact: undefined,
          askStatus: "asked",
        },
        COUNSELOR_ACTOR,
      );
    });

    it("lets an admin pass the counselor bar (role matrix)", async () => {
      signInAs("admin@example.com", "admin");
      vi.mocked(requireCaseAccess).mockResolvedValue(ADMIN_ACCESS);

      const res = await PATCH(
        makeRequest("PATCH", { action: "update", recommenderId: REC_ID, askStatus: "asked" }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      expect(updateRecommender).toHaveBeenCalledWith(
        CASE_ID,
        REC_ID,
        expect.objectContaining({ askStatus: "asked" }),
        { email: "admin@example.com", role: "admin" },
      );
    });

    it("returns 409 for an illegal askStatus transition (lib rule)", async () => {
      vi.mocked(updateRecommender).mockRejectedValue(new Error("Conflict"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "update", recommenderId: REC_ID, askStatus: "agreed" }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });

    it("returns 400 for an unknown askStatus (fail-closed)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "update", recommenderId: REC_ID, askStatus: "ghosted" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateRecommender).not.toHaveBeenCalled();
    });

    it("returns 400 when recommenderId is not a UUID", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "update", recommenderId: "not-a-uuid", askStatus: "asked" }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(updateRecommender).not.toHaveBeenCalled();
    });

    it("returns 404 when the recommender does not exist in this case", async () => {
      vi.mocked(updateRecommender).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "update", recommenderId: REC_ID, askStatus: "asked" }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    });
  });

  describe("PATCH action=link", () => {
    it("links a recommender to a college after pinning it to this case", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "link", recommenderId: REC_ID, listItemId: ITEM_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ link: LINK_DTO });
      expect(listRecommenders).toHaveBeenCalledWith(CASE_ID);
      expect(linkRecommenderToCollege).toHaveBeenCalledWith(REC_ID, ITEM_ID, COUNSELOR_ACTOR);
    });

    it("returns 409 for a duplicate link (lib rule)", async () => {
      vi.mocked(linkRecommenderToCollege).mockRejectedValue(new Error("Conflict"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "link", recommenderId: REC_ID, listItemId: ITEM_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "Conflict" });
    });

    it("returns 404 for a recommender belonging to another case (fail-closed scope pin)", async () => {
      vi.mocked(listRecommenders).mockResolvedValue([]);

      const res = await PATCH(
        makeRequest("PATCH", { action: "link", recommenderId: REC_ID, listItemId: ITEM_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      expect(linkRecommenderToCollege).not.toHaveBeenCalled();
    });

    it("returns 400 when listItemId is missing", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "link", recommenderId: REC_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(linkRecommenderToCollege).not.toHaveBeenCalled();
    });
  });

  describe("PATCH action=submission", () => {
    it("marks a per-college letter submitted", async () => {
      const submitted: AdmissionsRecommenderCollegeDto = {
        ...LINK_DTO,
        submitted: true,
        submittedAt: "2026-07-03T00:00:00.000Z",
      };
      vi.mocked(setRecommenderSubmission).mockResolvedValue(submitted);

      const res = await PATCH(
        makeRequest("PATCH", {
          action: "submission",
          recommenderId: REC_ID,
          listItemId: ITEM_ID,
          submitted: true,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ link: submitted });
      expect(setRecommenderSubmission).toHaveBeenCalledWith(
        REC_ID,
        ITEM_ID,
        true,
        COUNSELOR_ACTOR,
      );
    });

    it("returns 404 for a recommender belonging to another case (fail-closed scope pin)", async () => {
      vi.mocked(listRecommenders).mockResolvedValue([]);

      const res = await PATCH(
        makeRequest("PATCH", {
          action: "submission",
          recommenderId: REC_ID,
          listItemId: ITEM_ID,
          submitted: true,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      expect(setRecommenderSubmission).not.toHaveBeenCalled();
    });

    it("returns 400 when submitted is not a boolean", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          action: "submission",
          recommenderId: REC_ID,
          listItemId: ITEM_ID,
          submitted: "yes",
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(setRecommenderSubmission).not.toHaveBeenCalled();
    });

    it("returns 404 when the pair is not linked (lib rule)", async () => {
      vi.mocked(setRecommenderSubmission).mockRejectedValue(new Error("NotFound"));

      const res = await PATCH(
        makeRequest("PATCH", {
          action: "submission",
          recommenderId: REC_ID,
          listItemId: ITEM_ID,
          submitted: true,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH action=college_doc", () => {
    it("marks a transcript sent (no testSittingId)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          action: "college_doc",
          listItemId: ITEM_ID,
          docType: "transcript",
          sent: true,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ doc: DOC_DTO });
      expect(listCollegesForCase).toHaveBeenCalledWith(CASE_ID);
      expect(setCollegeDoc).toHaveBeenCalledWith(
        ITEM_ID,
        "transcript",
        { sent: true, testSittingId: null },
        COUNSELOR_ACTOR,
      );
    });

    it("marks a score send sent with its test sitting", async () => {
      const scoreDoc: AdmissionsCollegeDocDto = {
        ...DOC_DTO,
        docType: "score_send",
        testSittingId: SITTING_ID,
      };
      vi.mocked(setCollegeDoc).mockResolvedValue(scoreDoc);

      const res = await PATCH(
        makeRequest("PATCH", {
          action: "college_doc",
          listItemId: ITEM_ID,
          docType: "score_send",
          sent: true,
          testSittingId: SITTING_ID,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ doc: scoreDoc });
      expect(setCollegeDoc).toHaveBeenCalledWith(
        ITEM_ID,
        "score_send",
        { sent: true, testSittingId: SITTING_ID },
        COUNSELOR_ACTOR,
      );
    });

    it("returns 400 for score_send without a testSittingId (pairing rule)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          action: "college_doc",
          listItemId: ITEM_ID,
          docType: "score_send",
          sent: true,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(setCollegeDoc).not.toHaveBeenCalled();
    });

    it("returns 400 for a transcript WITH a testSittingId (pairing rule)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          action: "college_doc",
          listItemId: ITEM_ID,
          docType: "transcript",
          sent: true,
          testSittingId: SITTING_ID,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(setCollegeDoc).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown docType (fail-closed)", async () => {
      const res = await PATCH(
        makeRequest("PATCH", {
          action: "college_doc",
          listItemId: ITEM_ID,
          docType: "counselor_letter",
          sent: true,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expect(setCollegeDoc).not.toHaveBeenCalled();
    });

    it("returns 404 for a list item belonging to another case (fail-closed scope pin)", async () => {
      vi.mocked(listCollegesForCase).mockResolvedValue([]);

      const res = await PATCH(
        makeRequest("PATCH", {
          action: "college_doc",
          listItemId: ITEM_ID,
          docType: "transcript",
          sent: true,
        }),
        makeCtx(),
      );

      expect(res.status).toBe(404);
      expect(setCollegeDoc).not.toHaveBeenCalled();
    });
  });

  describe("PATCH (shared boundary)", () => {
    it("returns 400 for an unknown action", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { action: "archive", recommenderId: REC_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(400);
      expectNoMutations();
    });

    it("returns 400 for a non-JSON body", async () => {
      const res = await PATCH(makeRequest("PATCH"), makeCtx());

      expect(res.status).toBe(400);
      expectNoMutations();
    });

    it("returns 401 when unauthenticated", async () => {
      authMock.mockResolvedValue(null);

      const res = await PATCH(
        makeRequest("PATCH", { action: "update", recommenderId: REC_ID, askStatus: "asked" }),
        makeCtx(),
      );

      expect(res.status).toBe(401);
      expectNoMutations();
    });

    it("returns 403 for a student (below the counselor bar, role matrix)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "update", recommenderId: REC_ID, askStatus: "asked" }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expectNoMutations();
    });

    it("returns 403 for a parent (below the counselor bar, role matrix)", async () => {
      signInAs("mom@example.com", "parent");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await PATCH(
        makeRequest("PATCH", { action: "link", recommenderId: REC_ID, listItemId: ITEM_ID }),
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expectNoMutations();
    });
  });

  describe("DELETE", () => {
    it("soft-deletes a recommender via ?recommenderId= with the counselor bar", async () => {
      const res = await DELETE(makeDeleteRequest(REC_ID), makeCtx());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(requireCaseAccess).toHaveBeenCalledWith("counselor@example.com", CASE_ID, "counselor");
      expect(softDeleteRecommender).toHaveBeenCalledWith(CASE_ID, REC_ID, COUNSELOR_ACTOR);
    });

    it("returns 400 when recommenderId is missing", async () => {
      const res = await DELETE(makeDeleteRequest(), makeCtx());

      expect(res.status).toBe(400);
      expect(softDeleteRecommender).not.toHaveBeenCalled();
    });

    it("returns 400 when recommenderId is not a UUID", async () => {
      const res = await DELETE(makeDeleteRequest("not-a-uuid"), makeCtx());

      expect(res.status).toBe(400);
      expect(softDeleteRecommender).not.toHaveBeenCalled();
    });

    it("returns 404 when the recommender does not exist in this case", async () => {
      vi.mocked(softDeleteRecommender).mockRejectedValue(new Error("NotFound"));

      const res = await DELETE(makeDeleteRequest(REC_ID), makeCtx());

      expect(res.status).toBe(404);
    });

    it("returns 403 for a student (below the counselor bar, role matrix)", async () => {
      signInAs("student@example.com", "student");
      vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

      const res = await DELETE(makeDeleteRequest(REC_ID), makeCtx());

      expect(res.status).toBe(403);
      expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
      expect(softDeleteRecommender).not.toHaveBeenCalled();
    });
  });
});
