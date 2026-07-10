import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireAdmissionsSession: vi.fn(),
  requireCaseAccess: vi.fn(),
}));
vi.mock("@/lib/admissions/awards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/awards")>()),
  createAward: vi.fn(),
  listAwardsForCase: vi.fn(),
  setCommonAppAwardRanks: vi.fn(),
  softDeleteAward: vi.fn(),
  updateAward: vi.fn(),
}));

import { requireAdmissionsSession, requireCaseAccess } from "@/lib/admissions/access";
import {
  createAward,
  listAwardsForCase,
  setCommonAppAwardRanks,
  softDeleteAward,
  updateAward,
  type AwardDto,
} from "@/lib/admissions/awards";
import { DELETE, GET, PATCH, POST } from "../route";
import type { CaseAccess } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const AWARD_ID = "22222222-2222-4222-8222-222222222222";
const ACCESS: CaseAccess = { caseId: CASE_ID, email: "student@example.com", role: "student", isAdmin: false };
const DTO: AwardDto = {
  id: AWARD_ID,
  caseId: CASE_ID,
  title: "Math Olympiad",
  organization: null,
  gradeLevels: ["11"],
  recognitionLevels: ["national"],
  awardDate: null,
  commonAppRank: 1,
  ucEligibilityNarrative: null,
  ucAchievementNarrative: null,
  internalNotes: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};
const ctx = { params: Promise.resolve({ caseId: CASE_ID }) };
function request(method: string, body?: unknown) {
  return new Request(`http://test.local/api/admissions/cases/${CASE_ID}/awards`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("/api/admissions/cases/[caseId]/awards", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireAdmissionsSession).mockResolvedValue({ email: ACCESS.email, name: "Student", role: "student" });
    vi.mocked(requireCaseAccess).mockResolvedValue(ACCESS);
    vi.mocked(listAwardsForCase).mockResolvedValue([DTO]);
    vi.mocked(createAward).mockResolvedValue(DTO);
    vi.mocked(updateAward).mockResolvedValue(DTO);
    vi.mocked(setCommonAppAwardRanks).mockResolvedValue(undefined);
    vi.mocked(softDeleteAward).mockResolvedValue(undefined);
  });

  it("lists student-visible rows with internal notes redacted", async () => {
    const response = await GET(request("GET"), ctx);
    expect(response.status).toBe(200);
    expect(listAwardsForCase).toHaveBeenCalledWith(CASE_ID, { includeInternalNotes: false });
  });

  it("lets a student create a validated award", async () => {
    const response = await POST(request("POST", {
      title: "Math Olympiad",
      gradeLevels: ["11"],
      recognitionLevels: ["national"],
      commonAppRank: 1,
    }), ctx);
    expect(response.status).toBe(200);
    expect(createAward).toHaveBeenCalledWith(expect.objectContaining({ access: ACCESS, title: "Math Olympiad" }));
  });

  it("rejects student attempts to write counselor-private notes", async () => {
    const response = await POST(request("POST", { title: "Math Olympiad", internalNotes: "private" }), ctx);
    expect(response.status).toBe(403);
    expect(createAward).not.toHaveBeenCalled();
  });

  it("rejects UC narratives over the hard limits", async () => {
    const response = await POST(request("POST", {
      title: "Math Olympiad",
      ucAchievementNarrative: "x".repeat(351),
    }), ctx);
    expect(response.status).toBe(400);
    expect(createAward).not.toHaveBeenCalled();
  });

  it("routes the atomic Common App rank action", async () => {
    const response = await PATCH(request("PATCH", { action: "rank", orderedIds: [AWARD_ID] }), ctx);
    expect(response.status).toBe(200);
    expect(setCommonAppAwardRanks).toHaveBeenCalledWith({ access: ACCESS, orderedIds: [AWARD_ID] });
  });

  it("updates and soft-deletes scoped awards", async () => {
    const updateResponse = await PATCH(request("PATCH", {
      action: "update",
      awardId: AWARD_ID,
      title: "IMO Bronze",
    }), ctx);
    expect(updateResponse.status).toBe(200);
    expect(updateAward).toHaveBeenCalledWith(expect.objectContaining({ access: ACCESS, awardId: AWARD_ID }));

    const deleteResponse = await DELETE(
      new Request(`http://test.local/api/admissions/cases/${CASE_ID}/awards?awardId=${AWARD_ID}`, { method: "DELETE" }),
      ctx,
    );
    expect(deleteResponse.status).toBe(200);
    expect(softDeleteAward).toHaveBeenCalledWith({ access: ACCESS, awardId: AWARD_ID });
  });
});

