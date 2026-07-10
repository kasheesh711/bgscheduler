import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCaseAccess: vi.fn(),
}));
vi.mock("@/lib/admissions/workbook-import-service", () => ({
  loadAdmissionsWorkbookPreview: vi.fn(),
  commitAdmissionsWorkbookImport: vi.fn(),
  listAdmissionsWorkbookImports: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  commitAdmissionsWorkbookImport,
  listAdmissionsWorkbookImports,
  loadAdmissionsWorkbookPreview,
} from "@/lib/admissions/workbook-import-service";
import {
  AdmissionsImportConflictChoiceRequiredError,
  AdmissionsImportSourceChangedError,
} from "@/lib/admissions/workbook-import-commit";
import { MissingGoogleSheetsTokenError } from "@/lib/sales-dashboard/google-oauth";
import { GET, POST } from "../route";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const authMock = auth as unknown as Mock;

function request(body: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cases/${CASE_ID}/imports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx() {
  return { params: Promise.resolve({ caseId: CASE_ID }) };
}

describe("/api/admissions/cases/[caseId]/imports", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: {
        email: "counselor@example.com",
        name: "Counselor",
        role: "counselor",
        allowedPages: ["/admissions"],
      },
    });
    vi.mocked(requireCaseAccess).mockResolvedValue({
      caseId: CASE_ID,
      email: "counselor@example.com",
      role: "counselor",
      isAdmin: false,
    });
    vi.mocked(loadAdmissionsWorkbookPreview).mockResolvedValue({
      spreadsheetId: "sheet-id",
      sourceFingerprint: "a".repeat(64),
      sourceTitle: "Student Copy",
      profile: {},
      academics: {},
      canonicalAcademicRecords: [],
      collegeCriteria: {},
      majorsCareers: {},
      meetings: [],
      tasks: [],
      activities: [],
      awards: [],
      tests: [],
      research: [],
      interestEvents: [],
      applications: [],
      essayPrompts: [],
      financialAid: [],
      scholarships: [],
      issues: [],
      changes: [],
      counts: {},
    });
    vi.mocked(commitAdmissionsWorkbookImport).mockResolvedValue({
      runId: "22222222-2222-4222-8222-222222222222",
      status: "committed",
      noOp: false,
      sourceFingerprint: "a".repeat(64),
      summary: { task: 2 },
    });
    vi.mocked(listAdmissionsWorkbookImports).mockResolvedValue([]);
  });

  it("returns a bounded workbook preview to an assigned counselor", async () => {
    const response = await POST(request({
      action: "preview",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-id/edit",
    }), ctx());

    expect(response.status).toBe(200);
    expect(requireCaseAccess).toHaveBeenCalledWith(
      "counselor@example.com",
      CASE_ID,
      "counselor",
    );
    expect(loadAdmissionsWorkbookPreview).toHaveBeenCalledWith({
      actorEmail: "counselor@example.com",
      caseId: CASE_ID,
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-id/edit",
    });
    await expect(response.json()).resolves.toEqual({
      preview: expect.objectContaining({ spreadsheetId: "sheet-id" }),
    });
  });

  it("checks counselor access before parsing or reading the workbook", async () => {
    vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));

    const response = await POST(request({ action: "preview", spreadsheetUrl: "bad" }), ctx());

    expect(response.status).toBe(403);
    expect(loadAdmissionsWorkbookPreview).not.toHaveBeenCalled();
  });

  it("returns 400 for a commit without the confirmed fingerprint", async () => {
    const response = await POST(request({ action: "commit", spreadsheetUrl: "sheet-id" }), ctx());

    expect(response.status).toBe(400);
    expect(loadAdmissionsWorkbookPreview).not.toHaveBeenCalled();
  });

  it("re-reads and atomically commits the counselor-confirmed workbook version", async () => {
    const response = await POST(request({
      action: "commit",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-id/edit",
      expectedFingerprint: "a".repeat(64),
      conflictPolicy: "preserve_existing",
    }), ctx());

    expect(response.status).toBe(200);
    expect(commitAdmissionsWorkbookImport).toHaveBeenCalledWith({
      access: expect.objectContaining({ caseId: CASE_ID, role: "counselor" }),
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-id/edit",
      expectedFingerprint: "a".repeat(64),
      conflictPolicy: "preserve_existing",
    });
    await expect(response.json()).resolves.toEqual({
      result: expect.objectContaining({ status: "committed", noOp: false }),
    });
  });

  it("returns a retryable conflict when the workbook changed after preview", async () => {
    vi.mocked(commitAdmissionsWorkbookImport).mockRejectedValue(
      new AdmissionsImportSourceChangedError(),
    );
    const response = await POST(request({
      action: "commit",
      spreadsheetUrl: "sheet-id",
      expectedFingerprint: "a".repeat(64),
    }), ctx());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The source workbook changed after preview. Generate a fresh preview before committing.",
    });
  });

  it("requires an explicit conflict choice after a prior workbook import", async () => {
    vi.mocked(commitAdmissionsWorkbookImport).mockRejectedValue(
      new AdmissionsImportConflictChoiceRequiredError(),
    );
    const response = await POST(request({
      action: "commit",
      spreadsheetUrl: "sheet-id",
      expectedFingerprint: "a".repeat(64),
    }), ctx());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This workbook has a prior import. Choose whether to preserve or overwrite existing values.",
    });
  });

  it("lists the case-scoped import history", async () => {
    vi.mocked(listAdmissionsWorkbookImports).mockResolvedValue([{
      id: "22222222-2222-4222-8222-222222222222",
      spreadsheetId: "sheet-id",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-id/edit",
      sourceFingerprint: "a".repeat(64),
      status: "committed",
      conflictPolicy: null,
      summary: { task: 2 },
      previewCounts: { tasks: 2 },
      changes: [],
      legacyWorksheetSections: {},
      issues: [],
      createdByEmail: "counselor@example.com",
      committedAt: "2026-07-10T00:00:00.000Z",
      errorSummary: null,
      createdAt: "2026-07-10T00:00:00.000Z",
    }]);

    const response = await GET(request({}), ctx());

    expect(response.status).toBe(200);
    expect(listAdmissionsWorkbookImports).toHaveBeenCalledWith(CASE_ID);
    await expect(response.json()).resolves.toEqual({
      imports: [expect.objectContaining({ status: "committed" })],
    });
  });

  it("makes a missing staff Sheets connection visible and retryable", async () => {
    vi.mocked(loadAdmissionsWorkbookPreview).mockRejectedValue(
      new MissingGoogleSheetsTokenError(),
    );

    const response = await POST(request({ action: "preview", spreadsheetUrl: "sheet-id" }), ctx());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Google Sheets access is not connected for this account.",
    });
  });
});
