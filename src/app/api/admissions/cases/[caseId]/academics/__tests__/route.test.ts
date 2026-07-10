import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireAdmissionsSession: vi.fn(),
  requireCaseAccess: vi.fn(),
}));
vi.mock("@/lib/admissions/academics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/academics")>()),
  createAcademicRecord: vi.fn(),
  getLegacyAcademicWorksheetForCase: vi.fn(),
  listAcademicRecordsForCase: vi.fn(),
  softDeleteAcademicRecord: vi.fn(),
  updateAcademicRecord: vi.fn(),
}));

import { requireAdmissionsSession, requireCaseAccess } from "@/lib/admissions/access";
import {
  createAcademicRecord,
  getLegacyAcademicWorksheetForCase,
  listAcademicRecordsForCase,
  softDeleteAcademicRecord,
  updateAcademicRecord,
  type AdmissionsAcademicRecordDto,
} from "@/lib/admissions/academics";
import { DELETE, GET, PATCH, POST } from "../route";
import type { CaseAccess } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
const ACCESS: CaseAccess = { caseId: CASE_ID, email: "staff@example.com", role: "counselor", isAdmin: false };
const PAYLOAD = { system: "us" as const, gpaScale: 4, unweightedGpa: 3.8, fourYearCoursePlan: [] };
const DTO: AdmissionsAcademicRecordDto = {
  id: RECORD_ID,
  caseId: CASE_ID,
  system: "us",
  payload: PAYLOAD,
  effectiveDate: "2026-06-01",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};
const ctx = { params: Promise.resolve({ caseId: CASE_ID }) };
function request(method: string, body?: unknown) {
  return new Request(`http://test.local/api/admissions/cases/${CASE_ID}/academics`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("/api/admissions/cases/[caseId]/academics", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireAdmissionsSession).mockResolvedValue({ email: ACCESS.email, name: "Staff", role: "counselor" });
    vi.mocked(requireCaseAccess).mockResolvedValue(ACCESS);
    vi.mocked(listAcademicRecordsForCase).mockResolvedValue([DTO]);
    vi.mocked(getLegacyAcademicWorksheetForCase).mockResolvedValue({
      payload: { gpa: "3.8", curriculum: "IB" },
      importedAt: "2026-07-10T00:00:00.000Z",
    });
    vi.mocked(createAcademicRecord).mockResolvedValue(DTO);
    vi.mocked(updateAcademicRecord).mockResolvedValue(DTO);
    vi.mocked(softDeleteAcademicRecord).mockResolvedValue(undefined);
  });

  it("lists records for student-or-higher case members", async () => {
    const response = await GET(request("GET"), ctx);
    expect(response.status).toBe(200);
    expect(requireCaseAccess).toHaveBeenCalledWith(ACCESS.email, CASE_ID, "student");
    await expect(response.json()).resolves.toEqual({
      records: [DTO],
      legacyImport: {
        payload: { gpa: "3.8", curriculum: "IB" },
        importedAt: "2026-07-10T00:00:00.000Z",
      },
    });
  });

  it("creates a validated counselor-owned record", async () => {
    const response = await POST(request("POST", { payload: PAYLOAD, effectiveDate: "2026-06-01" }), ctx);
    expect(response.status).toBe(200);
    expect(requireCaseAccess).toHaveBeenCalledWith(ACCESS.email, CASE_ID, "counselor");
    expect(createAcademicRecord).toHaveBeenCalledWith({ access: ACCESS, payload: PAYLOAD, effectiveDate: "2026-06-01" });
  });

  it("rejects malformed academic variants at the boundary", async () => {
    const response = await POST(request("POST", {
      payload: { system: "ib", program: "dp", subjects: [], predictedTotal: 46 },
      effectiveDate: "2026-06-01",
    }), ctx);
    expect(response.status).toBe(400);
    expect(createAcademicRecord).not.toHaveBeenCalled();
  });

  it("updates with a concurrency token", async () => {
    const response = await PATCH(request("PATCH", {
      recordId: RECORD_ID,
      expectedUpdatedAt: DTO.updatedAt,
      effectiveDate: "2026-06-15",
    }), ctx);
    expect(response.status).toBe(200);
    expect(updateAcademicRecord).toHaveBeenCalledWith({
      access: ACCESS,
      recordId: RECORD_ID,
      expectedUpdatedAt: DTO.updatedAt,
      effectiveDate: "2026-06-15",
    });
  });

  it("soft-deletes a scoped record", async () => {
    const response = await DELETE(
      new Request(`http://test.local/api/admissions/cases/${CASE_ID}/academics?recordId=${RECORD_ID}`, { method: "DELETE" }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(softDeleteAcademicRecord).toHaveBeenCalledWith({ access: ACCESS, recordId: RECORD_ID });
  });

  it("fails closed before parsing when the caller lacks counselor access", async () => {
    vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));
    const response = await POST(request("POST", { payload: PAYLOAD, effectiveDate: "2026-06-01" }), ctx);
    expect(response.status).toBe(403);
    expect(createAcademicRecord).not.toHaveBeenCalled();
  });
});
