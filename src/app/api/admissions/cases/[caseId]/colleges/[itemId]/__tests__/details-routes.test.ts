import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCaseAccess: vi.fn(),
  assertCaseMutationAllowed: vi.fn(),
}));
vi.mock("@/lib/admissions/college-details", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/college-details")>()),
  getCollegeResearch: vi.fn(),
  upsertCollegeResearch: vi.fn(),
  listInterestEvents: vi.fn(),
  createInterestEvent: vi.fn(),
  updateInterestEvent: vi.fn(),
  deleteInterestEvent: vi.fn(),
  listCollegeRequirements: vi.fn(),
  createCollegeRequirement: vi.fn(),
  updateCollegeRequirement: vi.fn(),
  deleteCollegeRequirement: vi.fn(),
  getFinancialAidOffer: vi.fn(),
  upsertFinancialAidOffer: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { assertCaseMutationAllowed, requireCaseAccess } from "@/lib/admissions/access";
import {
  createCollegeRequirement,
  createInterestEvent,
  getCollegeResearch,
  upsertCollegeResearch,
  upsertFinancialAidOffer,
} from "@/lib/admissions/college-details";
import * as researchRoute from "../research/route";
import * as interestRoute from "../interest-events/route";
import * as requirementsRoute from "../requirements/route";
import * as aidRoute from "../financial-aid/route";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const authMock = auth as unknown as Mock;
const ACCESS = { caseId: CASE_ID, email: "student@example.com", role: "student" as const, isAdmin: false };
const RESEARCH = {
  id: "33333333-3333-4333-8333-333333333333",
  listItemId: ITEM_ID,
  fitRating: 4,
  sources: [{ label: "Admissions site", url: "https://example.edu" }],
  campusVisitDate: null,
  campusVisitNotes: null,
  academicNotes: "Strong CS program",
  opportunities: null,
  questions: null,
  notes: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function ctx() {
  return { params: Promise.resolve({ caseId: CASE_ID, itemId: ITEM_ID }) };
}

function request(path: string, method: string, body: unknown) {
  return new NextRequest(`http://test.local${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("college parity routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: { email: "student@example.com", name: "Student", role: "student", allowedPages: ["/admissions"] },
    });
    vi.mocked(requireCaseAccess).mockResolvedValue(ACCESS);
    vi.mocked(getCollegeResearch).mockResolvedValue(RESEARCH);
    vi.mocked(upsertCollegeResearch).mockResolvedValue(RESEARCH);
    vi.mocked(createInterestEvent).mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      listItemId: ITEM_ID,
      type: "campus_visit",
      eventDate: "2026-10-10",
      notes: "Tour",
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: "2026-10-10T00:00:00.000Z",
    });
    vi.mocked(createCollegeRequirement).mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      listItemId: ITEM_ID,
      kind: "portfolio",
      title: "Submit portfolio",
      status: "not_started",
      owner: "student",
      dueDate: null,
      required: true,
      sourceUrl: null,
      notes: null,
      sortOrder: 0,
      verifiedByEmail: null,
      verifiedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    vi.mocked(upsertFinancialAidOffer).mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      listItemId: ITEM_ID,
      currency: "USD",
      awardYear: 2027,
      costBreakdown: { tuition: 80_000 },
      giftAidBreakdown: { grant: 30_000 },
      loanBreakdown: {},
      workStudyAmount: null,
      netCost: null,
      remainingBalance: null,
      totalCost: 80_000,
      totalGiftAid: 30_000,
      totalLoans: 0,
      derivedNetCost: 50_000,
      derivedRemainingBalance: 50_000,
      notes: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("reads and updates student-owned research with lifecycle enforcement", async () => {
    const getResponse = await researchRoute.GET(new Request("http://test.local"), ctx());
    expect(getResponse.status).toBe(200);
    const patchResponse = await researchRoute.PATCH(request(
      `/api/admissions/cases/${CASE_ID}/colleges/${ITEM_ID}/research`,
      "PATCH",
      { fitRating: 4, sources: [{ label: "Admissions site", url: "https://example.edu" }] },
    ), ctx());
    expect(patchResponse.status).toBe(200);
    expect(assertCaseMutationAllowed).toHaveBeenCalled();
    expect(upsertCollegeResearch).toHaveBeenCalledWith(expect.objectContaining({ listItemId: ITEM_ID }));
  });

  it("records a typed demonstrated-interest event", async () => {
    const response = await interestRoute.POST(request(
      `/api/admissions/cases/${CASE_ID}/colleges/${ITEM_ID}/interest-events`,
      "POST",
      { type: "campus_visit", eventDate: "2026-10-10", notes: "Tour" },
    ), ctx());
    expect(response.status).toBe(200);
    expect(createInterestEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "campus_visit" }));
  });

  it("never creates a parent-owned requirement", async () => {
    const response = await requirementsRoute.POST(request(
      `/api/admissions/cases/${CASE_ID}/colleges/${ITEM_ID}/requirements`,
      "POST",
      { kind: "portfolio", title: "Submit portfolio", owner: "parent" },
    ), ctx());
    expect(response.status).toBe(400);
    expect(createCollegeRequirement).not.toHaveBeenCalled();
  });

  it("requires counselor access to define a requirement", async () => {
    vi.mocked(requireCaseAccess).mockResolvedValue({
      ...ACCESS,
      email: "staff@example.com",
      role: "counselor",
    });
    const response = await requirementsRoute.POST(request(
      `/api/admissions/cases/${CASE_ID}/colleges/${ITEM_ID}/requirements`,
      "POST",
      { kind: "portfolio", title: "Submit portfolio", owner: "student" },
    ), ctx());

    expect(response.status).toBe(200);
    expect(requireCaseAccess).toHaveBeenCalledWith(
      "student@example.com",
      CASE_ID,
      "counselor",
    );
    expect(createCollegeRequirement).toHaveBeenCalledWith(expect.objectContaining({
      access: expect.objectContaining({ role: "counselor" }),
      owner: "student",
    }));
  });

  it("requires counselor access for authoritative aid offers and returns derived totals", async () => {
    vi.mocked(requireCaseAccess).mockResolvedValue({ ...ACCESS, email: "staff@example.com", role: "counselor" });
    const response = await aidRoute.PUT(request(
      `/api/admissions/cases/${CASE_ID}/colleges/${ITEM_ID}/financial-aid`,
      "PUT",
      { awardYear: 2027, costBreakdown: { tuition: 80_000 }, giftAidBreakdown: { grant: 30_000 } },
    ), ctx());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ offer: expect.objectContaining({ derivedNetCost: 50_000 }) });
    expect(requireCaseAccess).toHaveBeenCalledWith("student@example.com", CASE_ID, "counselor");
  });
});
