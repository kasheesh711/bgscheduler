import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sales-dashboard/sheets", () => ({
  fetchGoogleSheetRange: vi.fn(),
  getGoogleSheetMetadata: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db";
import {
  fetchGoogleSheetRange,
  getGoogleSheetMetadata,
} from "@/lib/sales-dashboard/sheets";
import {
  listAdmissionsWorkbookImports,
  loadAdmissionsWorkbookPreview,
} from "../workbook-import-service";

describe("workbook import Google Sheets reads", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getGoogleSheetMetadata).mockResolvedValue({
      title: "Student Copy",
      sheetTitles: ["ApplicationTracker"],
    });
    const chain = () => {
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
        builder[method] = () => builder;
      }
      (builder as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve([]).then(resolve, reject);
      return builder;
    };
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(chain),
    } as never);
  });

  it("never fetches the CW portal-password column and preserves absolute mappings", async () => {
    const left = Array.from({ length: 97 }, () => null) as unknown[];
    left[0] = "Example University"; // D
    left[95] = "https://portal.example.edu"; // CU
    const right = Array.from({ length: 7 }, () => null) as unknown[];
    right[1] = "Computer Science"; // CY
    right[3] = "$12,500"; // DA
    vi.mocked(fetchGoogleSheetRange).mockImplementation(async (
      _email,
      _spreadsheetId,
      _sheetName,
      range,
    ) => {
      if (range === "D33:CV52") return [left];
      if (range === "CX33:DD52") return [right];
      throw new Error(`Unexpected range ${range}`);
    });

    const preview = await loadAdmissionsWorkbookPreview({
      actorEmail: "staff@example.com",
      caseId: "11111111-1111-4111-8111-111111111111",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/12345678901234567890/edit",
    });

    const ranges = vi.mocked(fetchGoogleSheetRange).mock.calls.map((call) => call[3]);
    expect(ranges).toContain("D33:CV52");
    expect(ranges).toContain("CX33:DD52");
    expect(ranges).not.toContain("D33:DD52");
    expect(preview.applications[0]).toMatchObject({
      collegeName: "Example University",
      portalUrl: "https://portal.example.edu",
      acceptedProgram: "Computer Science",
      scholarshipAmount: 12_500,
    });
    expect(JSON.stringify(preview)).not.toMatch(/password/i);
  });

  it("pads sparse ApplicationTracker rectangles before inserting the CW placeholder", async () => {
    vi.mocked(fetchGoogleSheetRange).mockImplementation(async (
      _email,
      _spreadsheetId,
      _sheetName,
      range,
    ) => {
      if (range === "D33:CV52") return [["Sparse University"]];
      if (range === "CX33:DD52") {
        return [[null, "Data Science", "Merit", "$8,000", "Enroll", "Keep notes", "tail"]];
      }
      throw new Error(`Unexpected range ${range}`);
    });

    const preview = await loadAdmissionsWorkbookPreview({
      actorEmail: "staff@example.com",
      caseId: "11111111-1111-4111-8111-111111111111",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/12345678901234567890/edit",
    });

    expect(preview.applications[0]).toMatchObject({
      collegeName: "Sparse University",
      portalUrl: null,
      acceptedProgram: "Data Science",
      scholarshipType: "Merit",
      scholarshipAmount: 8_000,
      studentDecision: "Enroll",
      notes: "Keep notes",
    });
  });

  it("filters formula-owned cells on ordinary ranges before parsing and fingerprinting", async () => {
    vi.mocked(getGoogleSheetMetadata).mockResolvedValue({
      title: "Student Copy",
      sheetTitles: ["Meetings"],
    });
    let renderedFormulaResult = "Calculated master note A";
    vi.mocked(fetchGoogleSheetRange).mockImplementation(async (
      _email,
      _spreadsheetId,
      sheetName,
      range,
      renderOption,
    ) => {
      expect(sheetName).toBe("Meetings");
      expect(range).toBe("A1:F12");
      const rows = Array.from({ length: 4 }, () => [] as unknown[]);
      if (renderOption === "FORMULA") {
        rows[2] = [null, null, null, null, "=VLOOKUP(A3,Master!A:B,2,FALSE)"];
        rows[3] = [null, null, "15/09/2026", null, "Literal counselor note"];
      } else {
        rows[2] = [null, null, null, null, renderedFormulaResult];
        rows[3] = [null, null, "15/09/2026", null, "Literal counselor note"];
      }
      return rows;
    });

    const input = {
      actorEmail: "staff@example.com",
      caseId: "11111111-1111-4111-8111-111111111111",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/12345678901234567890/edit",
    };
    const first = await loadAdmissionsWorkbookPreview(input);
    renderedFormulaResult = "Calculated master note B";
    const second = await loadAdmissionsWorkbookPreview(input);

    expect(first.meetings).toEqual([
      expect.objectContaining({
        sourceRef: "Meetings!A4:F4",
        meetingDate: "2026-09-15",
        notes: "Literal counselor note",
      }),
    ]);
    expect(first.sourceFingerprint).toBe(second.sourceFingerprint);
    expect(vi.mocked(fetchGoogleSheetRange).mock.calls.some((call) => call[4] === "FORMULA"))
      .toBe(true);
  });

  it("previews canonical student and US academic changes without treating personal email as login identity", async () => {
    vi.mocked(getGoogleSheetMetadata).mockResolvedValue({
      title: "Student Copy",
      sheetTitles: ["About You"],
    });
    const rows = Array.from({ length: 16 }, () => [] as unknown[]);
    rows[4] = [
      null,
      "Imported Legal Name",
      "Imported Preferred",
      "Imported address",
      null,
      "+66 80 000 0000",
      "personal-only@example.com",
    ];
    rows[11] = [null, "Imported School"];
    rows[13] = [null, "3.75 / 4", "4.2"];
    rows[15] = [null, "10", "150"];
    vi.mocked(fetchGoogleSheetRange).mockResolvedValue(rows);

    const results = [
      [],
      [],
      [{
        fullName: "Existing Legal Name",
        preferredName: null,
        phone: null,
        school: null,
        schoolCounselor: null,
      }],
      [{
        payload: {
          system: "us",
          gpaScale: 4,
          unweightedGpa: 3.5,
          fourYearCoursePlan: [],
        },
      }],
    ];
    let selectIndex = 0;
    const chain = (result: unknown[]) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
        builder[method] = () => builder;
      }
      (builder as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject);
      return builder;
    };
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => chain(results[selectIndex++] ?? [])),
    } as never);

    const preview = await loadAdmissionsWorkbookPreview({
      actorEmail: "staff@example.com",
      caseId: "11111111-1111-4111-8111-111111111111",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/12345678901234567890/edit",
    });

    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: "student_profile",
        field: "fullName",
        oldValue: "Existing Legal Name",
        newValue: "Imported Legal Name",
      }),
      expect.objectContaining({
        target: "academic_record:us",
        field: "unweightedGpa",
      }),
      expect.objectContaining({
        target: "self_report:about_you",
        field: "personal_email",
        newValue: "personal-only@example.com",
      }),
    ]));
    expect(preview.changes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "studentEmail" }),
    ]));
    expect(preview.counts).toMatchObject({
      canonicalProfileFields: 4,
      canonicalAcademicRecords: 1,
    });
  });

  it("shows section fields that overwrite would remove", async () => {
    vi.mocked(getGoogleSheetMetadata).mockResolvedValue({
      title: "Student Copy",
      sheetTitles: ["About You"],
    });
    vi.mocked(fetchGoogleSheetRange).mockResolvedValue([
      ["Citizenship", "United States"],
    ]);
    const results = [
      [{ sectionKey: "about_you", payload: { citizenship: "Thailand", legacy_field: "remove me" } }],
      [],
      [],
      [],
      [],
    ];
    let selectIndex = 0;
    const chain = (rows: unknown[]) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
        builder[method] = () => builder;
      }
      (builder as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return builder;
    };
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => chain(results[selectIndex++] ?? [])),
    } as never);

    const preview = await loadAdmissionsWorkbookPreview({
      actorEmail: "staff@example.com",
      caseId: "11111111-1111-4111-8111-111111111111",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/12345678901234567890/edit",
    });

    expect(preview.changes).toEqual(expect.arrayContaining([
      {
        target: "self_report:about_you",
        field: "legacy_field",
        oldValue: "remove me",
        newValue: null,
      },
    ]));
  });

  it("previews field-level changes for IB and A-Level academic systems", async () => {
    vi.mocked(getGoogleSheetMetadata).mockResolvedValue({
      title: "Student Copy",
      sheetTitles: ["Academics"],
    });
    const rows = Array.from({ length: 100 }, () => [] as unknown[]);
    rows[1] = [null, null, null, "IB DP / A-Level"];
    rows[3] = [null, null, "English"];
    rows[67] = [null, null, 7];
    rows[68] = [null, null, "HL"];
    rows[78] = [
      null,
      "Mathematics",
      null,
      "Cambridge International",
      null,
      "A Level",
      null,
      "A*",
    ];
    vi.mocked(fetchGoogleSheetRange).mockResolvedValue(rows);

    const existingAcademics = [
      {
        system: "ib",
        effectiveDate: "2026-06-01",
        payload: {
          system: "ib",
          program: "dp",
          subjects: [{ subject: "English", level: "HL", predictedGrade: 6 }],
        },
      },
      {
        system: "a_level_igcse",
        effectiveDate: "2026-06-01",
        payload: {
          system: "a_level_igcse",
          subjects: [{
            qualification: "a_level",
            subject: "Mathematics",
            board: "Cambridge International",
            predictedGrade: "B",
          }],
        },
      },
    ];
    const results = [[], [], [], existingAcademics, []];
    let selectIndex = 0;
    const chain = (result: unknown[]) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
        builder[method] = () => builder;
      }
      (builder as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject);
      return builder;
    };
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => chain(results[selectIndex++] ?? [])),
    } as never);

    const preview = await loadAdmissionsWorkbookPreview({
      actorEmail: "staff@example.com",
      caseId: "11111111-1111-4111-8111-111111111111",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/12345678901234567890/edit",
    });

    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: "academic_record:ib",
        field: "subjects",
      }),
      expect.objectContaining({
        target: "academic_record:a_level_igcse",
        field: "subjects",
      }),
    ]));
  });

  it("reports unresolved colleges referenced outside the application tracker", async () => {
    vi.mocked(getGoogleSheetMetadata).mockResolvedValue({
      title: "Student Copy",
      sheetTitles: [
        "Research Notes",
        "Demonstrate Interest",
        "Essay Prompts",
        " FinAidComparisons",
      ],
    });
    vi.mocked(fetchGoogleSheetRange).mockImplementation(async (
      _email,
      _spreadsheetId,
      sheetName,
    ) => {
      if (sheetName === "Research Notes") {
        const rows = Array.from({ length: 3 }, () => [] as unknown[]);
        rows[2] = [null, "Research College", null, null, "Academic notes"];
        return rows;
      }
      if (sheetName === "Demonstrate Interest") {
        const rows = Array.from({ length: 8 }, () => [] as unknown[]);
        rows[7] = ["Interest College", "10/09/2026", "Virtual event"];
        return rows;
      }
      if (sheetName === "Essay Prompts") {
        const rows = Array.from({ length: 3 }, () => [] as unknown[]);
        rows[2] = [null, "Essay College", "https://example.edu/prompts", null, "Why us?"];
        return rows;
      }
      if (sheetName === " FinAidComparisons") {
        const rows = Array.from({ length: 2 }, () => [] as unknown[]);
        rows[1] = [null, null, "Aid College"];
        return rows;
      }
      throw new Error(`Unexpected sheet ${sheetName}`);
    });

    const result = await loadAdmissionsWorkbookPreview({
      actorEmail: "staff@example.com",
      caseId: "11111111-1111-4111-8111-111111111111",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/12345678901234567890/edit",
    });

    expect(result.issues
      .filter((issue) => issue.code === "unresolved_college")
      .map((issue) => issue.range))
      .toEqual(expect.arrayContaining([
        "Research College",
        "Interest College",
        "Essay College",
        "Aid College",
      ]));
  });

  it("surfaces the 20-activity cap as a blocking preview issue using live case rows", async () => {
    vi.mocked(getGoogleSheetMetadata).mockResolvedValue({
      title: "Student Copy",
      sheetTitles: ["Activities -"],
    });
    const activityRows = Array.from({ length: 4 }, () => [] as unknown[]);
    activityRows[3] = [null, "One too many"];
    vi.mocked(fetchGoogleSheetRange).mockResolvedValue(activityRows);

    const existingActivities = Array.from({ length: 20 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Existing activity ${index + 1}`,
    }));
    const results = [[], [], [], [], existingActivities];
    let selectIndex = 0;
    const chain = (rows: unknown[]) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
        builder[method] = () => builder;
      }
      (builder as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return builder;
    };
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => chain(results[selectIndex++] ?? [])),
    } as never);

    const result = await loadAdmissionsWorkbookPreview({
      actorEmail: "staff@example.com",
      caseId: "11111111-1111-4111-8111-111111111111",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/12345678901234567890/edit",
    });

    expect(result.counts.liveActivitiesAfterImport).toBe(21);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        code: "activity_limit_exceeded",
      }),
    ]));
  });

  it("returns import history with committed counts, field changes, and issues", async () => {
    const run = {
      id: "22222222-2222-4222-8222-222222222222",
      caseId: "11111111-1111-4111-8111-111111111111",
      spreadsheetId: "12345678901234567890",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/12345678901234567890/edit",
      sourceFingerprint: "a".repeat(64),
      status: "committed",
      conflictPolicy: "preserve_existing",
      sourceMetadata: {
        previewCounts: { tasks: 2 },
        previewChanges: [{ target: "self_report:about_you", field: "citizenship", oldValue: null, newValue: "Thailand" }],
        legacyWorksheetSections: { collegeCriteria: { preferred_size: "Medium" } },
      },
      summary: { task: 2 },
      createdByEmail: "staff@example.com",
      committedAt: new Date("2026-07-10T00:00:00.000Z"),
      errorSummary: null,
      createdAt: new Date("2026-07-10T00:00:00.000Z"),
    };
    const issue = {
      runId: run.id,
      severity: "warning",
      code: "unresolved_college",
      sheetName: "ApplicationTracker",
      sourceRef: "Example University",
      message: "Example University will be created as a manual college entry.",
    };
    let selectIndex = 0;
    const results = [[run], [issue]];
    const chain = (rows: unknown[]) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "where", "orderBy", "limit"]) builder[method] = () => builder;
      (builder as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return builder;
    };
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => chain(results[selectIndex++] ?? [])),
    } as never);

    const history = await listAdmissionsWorkbookImports(run.caseId);

    expect(history).toEqual([expect.objectContaining({
      id: run.id,
      summary: { task: 2 },
      previewCounts: { tasks: 2 },
      changes: [expect.objectContaining({ field: "citizenship" })],
      legacyWorksheetSections: { collegeCriteria: { preferred_size: "Medium" } },
      issues: [expect.objectContaining({ code: "unresolved_college" })],
    })]);
  });
});
