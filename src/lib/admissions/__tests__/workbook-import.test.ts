import { describe, expect, it } from "vitest";

import {
  ADMISSIONS_WORKBOOK_RANGES,
  buildAdmissionsWorkbookPreview,
  deriveCanonicalStudentProfile,
  deriveImportedUsAcademicPayload,
  extractAdmissionsSpreadsheetId,
  normalizeImportedSentStatus,
} from "../workbook-import";

describe("admissions workbook import", () => {
  it("extracts a spreadsheet id from a URL or raw id", () => {
    expect(extractAdmissionsSpreadsheetId(
      "https://docs.google.com/spreadsheets/d/1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI/edit",
    )).toBe("1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI");
    expect(extractAdmissionsSpreadsheetId("1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI"))
      .toBe("1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI");
    expect(() => extractAdmissionsSpreadsheetId("https://example.com/not-a-sheet"))
      .toThrow(/Invalid Google Sheet/);
  });

  it("builds a deterministic preview and never imports portal passwords", () => {
    // The logical parser contract remains D:DD; the Sheets service test proves
    // the live read is split around credential-bearing CW.
    expect(ADMISSIONS_WORKBOOK_RANGES.applications.range).toBe("D33:DD52");
    const applicationRow = Array.from({ length: 105 }, () => null) as unknown[];
    const setAbsoluteColumn = (column: number, value: unknown) => {
      applicationRow[column - 4] = value;
    };
    setAbsoluteColumn(4, "Example University");
    setAbsoluteColumn(5, "In Progress");
    setAbsoluteColumn(30, "01/11/2026");
    setAbsoluteColumn(31, "EA");
    setAbsoluteColumn(99, "https://portal.example.edu");
    setAbsoluteColumn(101, "do-not-import-this-password");
    setAbsoluteColumn(103, "Computer Science");
    setAbsoluteColumn(105, "$12,500");

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sourceTitle: "Student Copy",
      sheetTitles: ["ApplicationTracker", "ScholarshipTracker"],
      ranges: {
        applications: [applicationRow],
        scholarships: [
          ["Private Scholarship Tracker"],
          ["Scholarship Name", "Sponsor Name", "Sponsor Address", "Contact Person", "Phone/Email", "Deadline Date", "Date Submitted", "Final Outcome", "Notes"],
          ["STEM Award", "Foundation", "Bangkok", "A. Person", "a@example.com", "15/12/2026", "", "Pending", "Essay required"],
        ],
      },
    });

    expect(preview.applications).toEqual([
      expect.objectContaining({
        sourceRef: "ApplicationTracker!D33:DD33",
        collegeName: "Example University",
        round: "EA",
        deadline: "2026-11-01",
        portalUrl: "https://portal.example.edu",
        acceptedProgram: "Computer Science",
        scholarshipAmount: 12500,
      }),
    ]);
    expect(JSON.stringify(preview)).not.toContain("do-not-import-this-password");
    expect(preview.scholarships).toEqual([
      expect.objectContaining({ sourceRef: "ScholarshipTracker!A3:J3" }),
    ]);
    expect(preview.counts.applications).toBe(1);
    expect(preview.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("parses demonstrated-interest event pairs and omits blank template rows", () => {
    const rows = Array.from({ length: 10 }, () => [] as unknown[]);
    rows[6] = ["SCHOOL", "DATE", "NOTES", "DATE", "NOTES", "DATE", "NOTES"];
    rows[7] = ["Example College", "10/09/2026", "Virtual event", "", "", "12/10/2026", "Campus visit"];

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["Demonstrate Interest"],
      ranges: { demonstratedInterest: rows },
    });

    expect(preview.interestEvents).toEqual([
      expect.objectContaining({
        sourceRef: "Demonstrate Interest!R8C2:R8C3",
        collegeName: "Example College",
        eventDate: "2026-09-10",
        notes: "Virtual event",
      }),
      expect.objectContaining({
        sourceRef: "Demonstrate Interest!R8C6:R8C7",
        collegeName: "Example College",
        eventDate: "2026-10-12",
        notes: "Campus visit",
      }),
    ]);
  });

  it("warns when meeting notes have no date because they cannot be committed", () => {
    const rows = Array.from({ length: 3 }, () => [] as unknown[]);
    rows[2] = [null, "Planned", null, null, "Discuss college list", "Send shortlist"];

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["Meetings"],
      ranges: { meetings: rows },
    });

    expect(preview.counts.meetings).toBe(0);
    expect(preview.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "warning",
        code: "missing_date",
        range: "Meetings!A3:F3",
      }),
    ]));
  });

  it("preserves long award titles and blocks duplicate normalized activity names", () => {
    const awardRows = Array.from({ length: 16 }, () => [] as unknown[]);
    const longTitle = `International research distinction ${"x".repeat(120)}`;
    awardRows[3] = [null, longTitle];
    awardRows[5] = Array.from({ length: 15 }, () => null);
    awardRows[5]![14] = "Award or honor";
    const awardPreview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["Activities -"],
      ranges: { activities: awardRows },
    });
    expect(awardPreview.awards[0]?.title).toBe(longTitle);

    const duplicateRows = Array.from({ length: 28 }, () => [] as unknown[]);
    duplicateRows[3] = [null, "Robotics Club"];
    duplicateRows[15] = [null, "  robotics   club  "];
    const duplicatePreview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["Activities -"],
      ranges: { activities: duplicateRows },
    });
    expect(duplicatePreview.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        code: "duplicate_source_activity",
      }),
    ]));
  });

  it("recognizes optional scholarship headers without misreading unrelated columns", () => {
    const rows = [
      ["Scholarships"],
      [
        "Scholarship Name",
        "Provider",
        "Link",
        "Requirements",
        "Deadline",
        "Outcome",
        "Offered Amount",
        "College",
        "Notes",
      ],
      [
        "STEM Fellowship",
        "Science Foundation",
        "https://example.org/apply",
        "Essay and transcript",
        "15/12/2026",
        "Awarded",
        "$12,500",
        "Example University",
        "Renewable",
      ],
    ];

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["ScholarshipTracker"],
      ranges: { scholarships: rows },
    });

    expect(preview.scholarships).toEqual([
      expect.objectContaining({
        sourceRef: "ScholarshipTracker!A3:J3",
        name: "STEM Fellowship",
        provider: "Science Foundation",
        providerAddress: null,
        contact: null,
        url: "https://example.org/apply",
        requirements: "Essay and transcript",
        offeredAmount: 12_500,
        collegeName: "Example University",
        deadline: "2026-12-15",
        outcome: "Awarded",
        notes: "Renewable",
      }),
    ]);
  });

  it("blocks negative aid amounts and credential-bearing scholarship links", () => {
    const aidRows = Array.from({ length: 4 }, () => [] as unknown[]);
    aidRows[1] = [null, null, "Example University"];
    aidRows[2] = [null, "Tuition & Fees", -50_000];
    aidRows[3] = [null, "Remaining Balance After Loans", Number.POSITIVE_INFINITY];
    const scholarshipRows = [
      [],
      ["Scholarship Name", "Link", "Offered Amount"],
      ["Unsafe Award", "https://student:secret@example.org/apply", -100],
    ];

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: [" FinAidComparisons", "ScholarshipTracker"],
      ranges: { financialAid: aidRows, scholarships: scholarshipRows },
    });

    expect(preview.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_financial_aid_amount", range: "C3" }),
      expect.objectContaining({ code: "invalid_financial_aid_amount", range: "C4" }),
      expect.objectContaining({ code: "invalid_scholarship_amount" }),
      expect.objectContaining({ code: "credentialed_url" }),
    ]));
  });

  it("blocks unsafe application, portal, and non-http scholarship URLs", () => {
    const application = Array.from({ length: 105 }, () => null) as unknown[];
    application[0] = "Unsafe University"; // D
    application[29] = "https://student:secret@example.edu/admissions"; // AG
    application[95] = "ftp://portal.example.edu"; // CU
    const scholarships = [
      [],
      ["Scholarship Name", "Link"],
      ["Unsafe Scheme Award", "file:///tmp/application"],
    ];

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["ApplicationTracker", "ScholarshipTracker"],
      ranges: { applications: [application], scholarships },
    });

    expect(preview.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "credentialed_url", range: "ApplicationTracker!D33:DD33" }),
      expect.objectContaining({ code: "invalid_external_url", range: "ApplicationTracker!D33:DD33" }),
      expect.objectContaining({ code: "invalid_external_url", range: "ScholarshipTracker!A3:J3" }),
    ]));
  });

  it("blocks and redacts credential-bearing academic links before archive metadata", () => {
    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["Academics"],
      ranges: {
        academics: [[
          "Transcript",
          "https://student:transcript-secret@example.edu/transcript",
        ]],
      },
    });

    expect(preview.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        code: "credentialed_url",
        range: "B1",
      }),
    ]));
    expect(preview.canonicalAcademicRecords).toEqual([]);
    expect(JSON.stringify(preview.academics)).not.toContain("transcript-secret");
  });

  it("keeps extended About You labels but excludes government IDs and credentials", () => {
    const rows = Array.from({ length: 45 }, () => [] as unknown[]);
    rows[39] = ["Household language", "Thai and English"];
    rows[40] = ["Passport number", "P1234567"];
    rows[41] = ["National ID", "1234567890123"];
    rows[42] = ["Portal password", "never-store-me"];

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["About You"],
      ranges: { aboutYou: rows },
    });

    expect(preview.profile.household_language).toBe("Thai and English");
    expect(JSON.stringify(preview.profile)).not.toMatch(/P1234567|1234567890123|never-store-me/);
  });

  it("maps legacy About You cells to canonical keys and safely derives a US academic record", () => {
    const rows = Array.from({ length: 20 }, () => [] as unknown[]);
    rows[4] = [
      null,
      "Taylor Student",
      "Tay",
      "123 Main St, Bangkok",
      null,
      "+66 81 234 5678",
      "legacy.personal@example.com",
    ];
    rows[6] = [null, "18/04/2009", null, "Thailand"];
    rows[11] = [null, "International School Bangkok"];
    rows[13] = [null, "3.82 / 4.0", "4.41", "Prior School, Singapore"];
    rows[15] = [null, "12", "180"];

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["About You", "Academics"],
      ranges: {
        aboutYou: rows,
        academics: [["IB predicted total", "42"]],
      },
    });

    expect(preview.profile).toMatchObject({
      legal_name: "Taylor Student",
      preferred_name: "Tay",
      home_address: "123 Main St, Bangkok",
      primary_phone: "+66 81 234 5678",
      personal_email: "legacy.personal@example.com",
      date_of_birth: "2009-04-18",
      countries_of_citizenship: "Thailand",
      current_school: "International School Bangkok",
      previous_schools: "Prior School, Singapore",
    });
    expect(preview.profile).not.toHaveProperty("address");
    expect(preview.profile).not.toHaveProperty("email");
    expect(deriveCanonicalStudentProfile(preview.profile)).toEqual({
      fullName: "Taylor Student",
      preferredName: "Tay",
      phone: "+66 81 234 5678",
      school: "International School Bangkok",
    });
    expect(deriveCanonicalStudentProfile(preview.profile)).not.toHaveProperty("studentEmail");
    expect(deriveImportedUsAcademicPayload(preview.profile).payload).toEqual({
      system: "us",
      gpaScale: 4,
      unweightedGpa: 3.82,
      weightedGpa: 4.41,
      classRank: 12,
      classSize: 180,
      fourYearCoursePlan: [],
    });
    expect(preview.counts).toMatchObject({
      canonicalProfileFields: 4,
      canonicalAcademicRecords: 1,
    });
    // Unsupported IB/UK grids remain intact for counselor verification.
    expect(preview.academics).toEqual({ ib_predicted_total: "42" });
  });

  it("maps the visible Academics grid into validated US, IB, and A-Level records", () => {
    const aboutYou = Array.from({ length: 16 }, () => [] as unknown[]);
    aboutYou[13] = [null, "3.82 / 4.0", "4.41"];
    aboutYou[15] = [null, "12", "180"];
    const academics = Array.from({ length: 100 }, () => [] as unknown[]);
    academics[1] = [null, null, null, "IB MYP / DP"];
    const subjects = [
      "English",
      "Mathematics",
      "Science",
      "Social Science",
      "Language Other Than English",
      "Visual/Performing Arts",
    ];
    subjects.forEach((subject, index) => {
      academics[index + 3] = [null, null, subject];
    });
    academics[3] = [null, null, "English", "Honors", null, 6, null, 7, null, "A", null, "A"];
    academics[28] = [null, null, "Class Rank", "12"];
    academics[29] = [null, null, "Transcript GPA (Weighted)", "4.5"];
    academics[30] = [null, null, "Transcript GPA (Unweighted)", "3.9 / 4"];
    academics[33] = [null, null, "Core GPA", "3.75"];
    academics[43] = [null, null, null, null, null, "Course selection", null, "Most demanding"];
    academics[60] = [null, null, "Transcript URL", "https://drive.google.com/transcript"];
    academics[61] = [null, null, "School Profile URL", "https://drive.google.com/school-profile"];
    academics[67] = [null, null, 7, 6, 6, 7, 5, 6];
    academics[68] = [null, null, "HL", "HL", "SL", "HL", "SL", "SL"];
    academics[69] = [null, null, "TOK grade", "A", null, "B", null, null, "CAS complete?", true];
    academics[72] = [null, null, "PREDICTED TOTAL / 45", 41];
    academics[78] = [
      null,
      "Mathematics",
      null,
      "Cambridge International",
      null,
      "A Level",
      null,
      "A*",
      null,
      "A",
    ];

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["About You", "Academics"],
      ranges: { aboutYou, academics },
    });

    expect(preview.canonicalAcademicRecords).toHaveLength(3);
    expect(preview.canonicalAcademicRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        system: "us",
        gpaScale: 4,
        unweightedGpa: 3.9,
        weightedGpa: 4.5,
        coreGpa: 3.75,
        classRank: 12,
        classSize: 180,
        courseRigor: "most_demanding",
        transcriptUrl: "https://drive.google.com/transcript",
        schoolProfileUrl: "https://drive.google.com/school-profile",
        fourYearCoursePlan: [
          expect.objectContaining({ gradeLevel: "9", courseTitle: "English", finalGrade: "6" }),
          expect.objectContaining({ gradeLevel: "10", courseTitle: "English", finalGrade: "7" }),
          expect.objectContaining({ gradeLevel: "11", courseTitle: "English", finalGrade: "A" }),
          expect.objectContaining({ gradeLevel: "12", courseTitle: "English", finalGrade: "A" }),
        ],
      }),
      expect.objectContaining({
        system: "ib",
        program: "myp_dp",
        tokGrade: "A",
        extendedEssayGrade: "B",
        casCompleted: true,
        predictedTotal: 41,
        subjects: expect.arrayContaining([
          { subject: "English", level: "MYP", finalGrade: 7 },
          { subject: "English", level: "HL", predictedGrade: 7 },
          { subject: "Mathematics", level: "HL", predictedGrade: 6 },
        ]),
      }),
      expect.objectContaining({
        system: "a_level_igcse",
        subjects: [{
          qualification: "a_level",
          subject: "Mathematics",
          board: "Cambridge International",
          predictedGrade: "A*",
          achievedGrade: "A",
        }],
      }),
    ]));
    expect(preview.counts.canonicalAcademicRecords).toBe(3);
    expect(preview.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "incomplete_academic_record" }),
    ]));
  });

  it("does not guess incomplete UK rows or classify hybrid IGCSE grades as MYP", () => {
    const academics = Array.from({ length: 100 }, () => [] as unknown[]);
    academics[1] = [null, null, null, "Hybrid IGCSE → IB DP"];
    academics[3] = [null, null, "English", "IGCSE", null, 7, null, 6];
    academics[78] = [null, "Mathematics", null, null, null, "A Level", null, "A*"];

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["Academics"],
      ranges: { academics },
    });

    expect(preview.canonicalAcademicRecords).toEqual([]);
    expect(preview.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "warning",
        code: "incomplete_academic_record",
        range: "Academics!B79:J79",
      }),
    ]));
  });

  it("does not guess an ambiguous GPA scale and explains the omitted canonical record", () => {
    const rows = Array.from({ length: 16 }, () => [] as unknown[]);
    rows[13] = [null, "3.8 / 10", null];
    rows[15] = [null, "rank unknown", "180"];

    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["About You"],
      ranges: { aboutYou: rows },
    });

    expect(deriveImportedUsAcademicPayload(preview.profile).payload).toBeNull();
    expect(preview.counts.canonicalAcademicRecords).toBe(0);
    expect(preview.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "warning",
        code: "invalid_academic_value",
        range: "gpa_scale",
      }),
      expect.objectContaining({
        severity: "warning",
        code: "invalid_academic_value",
        range: "class_rank",
      }),
    ]));
  });

  it("maps transcript status but refuses to guess aggregate recommendation or score-send identities", () => {
    expect(normalizeImportedSentStatus("Submitted")).toBe(true);
    expect(normalizeImportedSentStatus("Not sent")).toBe(false);
    expect(normalizeImportedSentStatus("Unsent")).toBe(false);
    expect(normalizeImportedSentStatus("Not yet sent")).toBe(false);
    expect(normalizeImportedSentStatus("Ask counselor")).toBeNull();

    const applicationRow = Array.from({ length: 105 }, () => null) as unknown[];
    const setAbsoluteColumn = (column: number, value: unknown) => {
      applicationRow[column - 4] = value;
    };
    setAbsoluteColumn(4, "Example University");
    setAbsoluteColumn(40, "Sent");
    setAbsoluteColumn(59, "All submitted");
    setAbsoluteColumn(65, "Submitted");
    const preview = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["ApplicationTracker"],
      ranges: { applications: [applicationRow] },
    });

    expect(preview.counts.transcriptDocs).toBe(1);
    expect(preview.issues.filter((issue) => issue.code === "manual_reconciliation_required"))
      .toHaveLength(2);
  });

  it("rejects impossible D/M/Y dates and counts only rows that can be committed", () => {
    const meetings = Array.from({ length: 3 }, () => [] as unknown[]);
    meetings[2] = [null, null, "31/02/2026", null, "Planning notes"];
    const tests = Array.from({ length: 5 }, () => [] as unknown[]);
    tests[4] = [null, null, null, null, null, null, null, "31/04/2026", 700, 760];
    const interest = Array.from({ length: 8 }, () => [] as unknown[]);
    interest[7] = ["Example College", "31/09/2026", "Virtual event"];

    const result = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["Meetings", "Tests", "Demonstrate Interest"],
      ranges: { meetings, tests, demonstratedInterest: interest },
    });

    expect(result.issues.filter((issue) => issue.code === "invalid_date")).toEqual([
      expect.objectContaining({ severity: "error", sheetName: "Meetings", range: "C3" }),
      expect.objectContaining({ severity: "error", sheetName: "Tests", range: "H5" }),
      expect.objectContaining({ severity: "error", sheetName: "Demonstrate Interest", range: "B8" }),
    ]);
    expect(result.counts).toMatchObject({ meetings: 0, tests: 0, interestEvents: 0 });
  });

  it("keeps undated legacy decisions as preview issues without promising an event", () => {
    const applicationRow = Array.from({ length: 105 }, () => null) as unknown[];
    const setAbsoluteColumn = (column: number, value: unknown) => {
      applicationRow[column - 4] = value;
    };
    setAbsoluteColumn(4, "Example University");
    setAbsoluteColumn(98, "Accepted");
    setAbsoluteColumn(106, "Committed — deposit paid");

    const result = buildAdmissionsWorkbookPreview({
      spreadsheetUrlOrId: "1O3QusJI_JubbVaw6ed4ICG98DEEg45jp3dettizLtwI",
      sheetTitles: ["ApplicationTracker"],
      ranges: { applications: [applicationRow] },
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "missing_date",
        range: "Example University",
        message: expect.stringContaining("no application event will be created"),
      }),
    ]));
    expect(result.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "multiple_committed_colleges" }),
    ]));
  });
});
