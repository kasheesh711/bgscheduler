import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  admissionsAuditLog,
  admissionsAcademicRecords,
  admissionsActivities,
  admissionsApplicationEvents,
  admissionsCaseTasks,
  admissionsCases,
  admissionsCollegeListItems,
  admissionsCollegeDocs,
  admissionsImportMappings,
  admissionsImportRuns,
  admissionsSelfReportSections,
  admissionsStudents,
  admissionsTestSittings,
} from "@/lib/db/schema";
import {
  AdmissionsImportConflictChoiceRequiredError,
  AdmissionsImportSourceChangedError,
  AdmissionsImportValidationError,
  commitAdmissionsWorkbookPreview,
  mapImportedEssayStatus,
  mapImportedScholarshipStatus,
} from "@/lib/admissions/workbook-import-commit";
import type {
  AdmissionsWorkbookPreview,
  ImportedApplication,
} from "@/lib/admissions/workbook-import";
import type { CaseAccess } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const SECTION_ID = "33333333-3333-4333-8333-333333333333";
const FINGERPRINT = "a".repeat(64);

const ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "counselor@example.com",
  role: "counselor",
  isAdmin: false,
};

function preview(overrides: Partial<AdmissionsWorkbookPreview> = {}): AdmissionsWorkbookPreview {
  return {
    spreadsheetId: "sheet-id-12345678901234567890",
    sourceFingerprint: FINGERPRINT,
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
    ...overrides,
  };
}

function importedApplication(
  overrides: Partial<ImportedApplication> = {},
): ImportedApplication {
  return {
    sourceRef: "ApplicationTracker!D33:DD33",
    collegeName: "Example University",
    overallStatus: null,
    deadline: null,
    round: null,
    admissionsUrl: null,
    firstChoiceMajor: null,
    secondChoiceMajor: null,
    collegeQuestionsStatus: null,
    essayStatus: null,
    testStatus: null,
    recommendationStatus: null,
    transcriptStatus: null,
    demonstratedInterestPolicy: null,
    demonstratedInterestWays: null,
    honorsProgramStatus: null,
    interviewStatus: null,
    portfolioStatus: null,
    scholarshipStatus: null,
    financialAidStatus: null,
    financialAidDeadline: null,
    fafsaStatus: null,
    decision: null,
    portalUrl: null,
    acceptedProgram: null,
    scholarshipType: null,
    scholarshipAmount: null,
    studentDecision: null,
    notes: null,
    ...overrides,
  };
}

interface InsertCall {
  table: unknown;
  values: unknown;
}

function fakeDb(
  selectQueue: unknown[][],
  options: { failAudit?: boolean; runInsertConflict?: boolean } = {},
) {
  let selectIndex = 0;
  let generated = 0;
  const inserts: InsertCall[] = [];
  const updates: Array<{ table: unknown; set: unknown }> = [];
  let rolledBack = false;
  let committed = false;

  function selectBuilder(rows: unknown[]) {
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit", "for"]) builder[method] = () => builder;
    (builder as { then: unknown }).then = (
      resolve: (value: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return builder;
  }

  const tx = {
    execute: vi.fn(async () => []),
    select: () => selectBuilder(selectQueue[selectIndex++] ?? []),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserts.push({ table, values });
        const first = Array.isArray(values) ? values[0] : values;
        const id = table === admissionsImportRuns
          ? RUN_ID
          : table === admissionsSelfReportSections
            ? SECTION_ID
            : `00000000-0000-4000-8000-${String(generated++).padStart(12, "0")}`;
        const row = {
          id,
          ...(typeof first === "object" && first ? first : {}),
          createdAt: new Date("2026-07-10T00:00:00Z"),
          updatedAt: new Date("2026-07-10T00:00:00Z"),
        };
        const error = options.failAudit && table === admissionsAuditLog
          ? new Error("audit insert failed")
          : null;
        const builder = {
          returning: () => error
            ? Promise.reject(error)
            : Promise.resolve(options.runInsertConflict && table === admissionsImportRuns ? [] : [row]),
          onConflictDoNothing: () => builder,
          then: (
            resolve: (value: unknown) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => (error ? Promise.reject(error) : Promise.resolve(undefined)).then(resolve, reject),
        };
        return builder;
      },
    }),
    update: (table: unknown) => ({
      set: (set: unknown) => {
        updates.push({ table, set });
        const builder: Record<string, unknown> = {};
        builder.where = () => builder;
        builder.returning = () => Promise.resolve(
          table === admissionsCases ? [{ id: CASE_ID }] : [],
        );
        (builder as { then: unknown }).then = (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(undefined).then(resolve, reject);
        return builder;
      },
    }),
    delete: () => ({ where: () => Promise.resolve(undefined) }),
  };
  const db = {
    ...tx,
    transaction: async (callback: (value: typeof tx) => Promise<unknown>) => {
      try {
        const value = await callback(tx);
        committed = true;
        return value;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  };
  return {
    db: db as never,
    execute: tx.execute,
    inserts,
    updates,
    state: () => ({ rolledBack, committed }),
  };
}

function commitInput(workbookPreview: AdmissionsWorkbookPreview) {
  return {
    access: ACCESS,
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-id-12345678901234567890/edit",
    expectedFingerprint: FINGERPRINT,
    conflictPolicy: "preserve_existing" as const,
    preview: workbookPreview,
  };
}

describe("legacy workbook commit", () => {
  it("maps negated essay and scholarship labels before positive substrings", () => {
    expect(mapImportedEssayStatus("Incomplete")).toBe("drafting");
    expect(mapImportedEssayStatus("Not complete")).toBe("drafting");
    expect(mapImportedEssayStatus("Complete")).toBe("final");
    expect(mapImportedScholarshipStatus("Not selected", null)).toBe("not_selected");
    expect(mapImportedScholarshipStatus("Not awarded", null)).toBe("not_selected");
    expect(mapImportedScholarshipStatus("Awarded", null)).toBe("awarded");
  });

  it("takes a transaction-scoped import lock before reading version history", async () => {
    const { db, execute } = fakeDb([[]]);

    await commitAdmissionsWorkbookPreview(commitInput(preview()), db);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("stores a canonical archive URL and rejects a URL for another spreadsheet", async () => {
    const accepted = fakeDb([[]]);
    await commitAdmissionsWorkbookPreview({
      ...commitInput(preview()),
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-id-12345678901234567890/edit?gid=42#gid=42",
    }, accepted.db);
    expect(accepted.inserts.find((call) => call.table === admissionsImportRuns)?.values)
      .toMatchObject({
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-id-12345678901234567890/edit",
      });

    const transaction = vi.fn();
    await expect(commitAdmissionsWorkbookPreview({
      ...commitInput(preview()),
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/different-sheet-12345678901234567890/edit",
    }, { transaction } as never)).rejects.toThrow("does not match");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rolls back a crafted preview that omits its unsafe-URL issue", async () => {
    const { db, state } = fakeDb([[], []]);

    await expect(commitAdmissionsWorkbookPreview(commitInput(preview({
      applications: [importedApplication({
        portalUrl: "https://student:secret@portal.example.edu/",
      })],
      // A hostile client cannot bypass defense-in-depth by deleting issues;
      // the commit domain validates again inside the transaction.
      issues: [],
    })), db)).rejects.toThrow("Invalid imported portalUrl");

    expect(state()).toEqual({ committed: false, rolledBack: true });
  });

  it("preserves counselor targets and family release when overwriting a test sitting", async () => {
    const sittingId = "99999999-9999-4999-8999-999999999999";
    const existing = {
      id: sittingId,
      caseId: CASE_ID,
      testType: "sat",
      testDate: "2026-05-01",
      subject: null,
      targetScore: "1500",
      actualScore: "1400",
      scoreDetails: { testType: "sat", math: 700, readingWriting: 700, total: 1400 },
      status: "score_received",
      scoreReleasedToParent: true,
      deletedAt: null,
    };
    const { db, updates } = fakeDb([[], [existing]]);

    await commitAdmissionsWorkbookPreview({
      ...commitInput(preview({
        tests: [{
          sourceRef: "Tests!H41:P41",
          testType: "sat",
          testDate: "2026-05-01",
          subject: null,
          scoreDetails: { math: 760, readingWriting: 740 },
        }],
      })),
      conflictPolicy: "overwrite_existing",
    }, db);

    const update = updates.find((call) => call.table === admissionsTestSittings);
    expect(update?.set).toMatchObject({ actualScore: "1500", status: "score_received" });
    expect(update?.set).not.toHaveProperty("targetScore");
    expect(update?.set).not.toHaveProperty("scoreReleasedToParent");
  });

  it("preserves existing profile fields on a first preserve-existing import", async () => {
    const { db, inserts, updates, state } = fakeDb([
      [],
      [{ studentId: "44444444-4444-4444-8444-444444444444" }],
      [{
        id: "44444444-4444-4444-8444-444444444444",
        fullName: "Existing Student",
        preferredName: null,
        studentEmail: "login@example.com",
        phone: null,
        school: null,
        schoolCounselor: null,
      }],
      [],
    ]);

    const result = await commitAdmissionsWorkbookPreview(
      commitInput(preview({
        profile: {
          legal_name: "Taylor Student",
          preferred_name: "Tay",
        },
      })),
      db,
    );

    expect(result).toEqual(expect.objectContaining({
      runId: RUN_ID,
      status: "committed",
      noOp: false,
      summary: { student_profile: 1, self_report_section: 1 },
    }));
    expect(state()).toEqual({ committed: true, rolledBack: false });
    expect(inserts.some((call) => call.table === admissionsImportRuns)).toBe(true);
    expect(inserts.some((call) => call.table === admissionsSelfReportSections)).toBe(true);
    const mappingCall = inserts.find((call) => call.table === admissionsImportMappings);
    expect(mappingCall?.values).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: RUN_ID,
        sourceType: "worksheet_section",
        sourceKey: "about_you",
        targetType: "self_report_section",
        targetId: SECTION_ID,
      }),
      expect.objectContaining({
        runId: RUN_ID,
        sourceType: "about_you_field",
        sourceKey: "fullName",
        targetType: "student_profile",
        targetId: "44444444-4444-4444-8444-444444444444",
      }),
    ]));
    expect(updates).toContainEqual(expect.objectContaining({
      table: admissionsStudents,
      set: expect.objectContaining({
        preferredName: "Tay",
      }),
    }));
    const studentUpdate = updates.find((call) => call.table === admissionsStudents)
      ?.set as Record<string, unknown>;
    expect(studentUpdate).not.toHaveProperty("fullName");
    expect(studentUpdate).not.toHaveProperty("studentEmail");
    expect(inserts.some((call) => call.table === admissionsAuditLog)).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({
      table: admissionsImportRuns,
      set: expect.objectContaining({ status: "committed" }),
    }));
  });

  it("creates a validated canonical US academic record and keeps the raw academic worksheet section", async () => {
    const { db, inserts } = fakeDb([
      [],
      [],
      [],
    ]);

    const result = await commitAdmissionsWorkbookPreview(commitInput(preview({
      profile: {
        gpa_unweighted: "3.9 / 4.0",
        gpa_weighted: "4.5",
        class_rank: "8",
        class_size: "160",
      },
      academics: {
        ib_predicted_total: "42",
        a_level_subjects: "Math, Physics, Economics",
      },
    })), db);

    expect(result.summary).toMatchObject({
      academic_record: 1,
      self_report_section: 2,
    });
    const academic = inserts.find((call) => call.table === admissionsAcademicRecords);
    expect(academic?.values).toMatchObject({
      caseId: CASE_ID,
      system: "us",
      payload: {
        system: "us",
        gpaScale: 4,
        unweightedGpa: 3.9,
        weightedGpa: 4.5,
        classRank: 8,
        classSize: 160,
        fourYearCoursePlan: [],
      },
    });
    const rawSection = inserts.find((call) =>
      call.table === admissionsSelfReportSections &&
      (call.values as { sectionKey?: string }).sectionKey === "legacy_academics");
    expect(rawSection?.values).toMatchObject({
      payload: {
        ib_predicted_total: "42",
        a_level_subjects: "Math, Physics, Economics",
      },
    });
    expect(inserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: admissionsAuditLog }),
      expect.objectContaining({ table: admissionsImportMappings }),
    ]));
  });

  it("atomically creates and maps all validated academic systems", async () => {
    const { db, inserts } = fakeDb([[], []]);
    const canonicalAcademicRecords: AdmissionsWorkbookPreview["canonicalAcademicRecords"] = [
      {
        system: "us",
        gpaScale: 4,
        unweightedGpa: 3.9,
        fourYearCoursePlan: [{
          gradeLevel: "12",
          courseTitle: "English",
          finalGrade: "A",
        }],
      },
      {
        system: "ib",
        program: "dp",
        subjects: [{ subject: "English", level: "HL", predictedGrade: 7 }],
        predictedTotal: 41,
      },
      {
        system: "a_level_igcse",
        subjects: [{
          qualification: "a_level",
          subject: "Mathematics",
          board: "Cambridge International",
          predictedGrade: "A*",
        }],
      },
    ];

    const result = await commitAdmissionsWorkbookPreview(commitInput(preview({
      canonicalAcademicRecords,
    })), db);

    expect(result.summary.academic_record).toBe(3);
    const records = inserts.filter((call) => call.table === admissionsAcademicRecords);
    expect(records).toHaveLength(3);
    expect(records.map((record) => (record.values as { system: string }).system)).toEqual([
      "us",
      "ib",
      "a_level_igcse",
    ]);
    const mappings = inserts.find((call) => call.table === admissionsImportMappings)?.values;
    expect(mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "academics_record",
        sourceKey: "us",
        targetType: "academic_record",
      }),
      expect.objectContaining({
        sourceType: "academics_record",
        sourceKey: "ib",
        targetType: "academic_record",
      }),
      expect.objectContaining({
        sourceType: "academics_record",
        sourceKey: "a_level_igcse",
        targetType: "academic_record",
      }),
    ]));
    expect(inserts.filter((call) => call.table === admissionsAuditLog)).toHaveLength(4);
  });

  it("preserves an existing prior-date academic record unless overwrite is explicit", async () => {
    const existing = {
      id: "55555555-5555-4555-8555-555555555555",
      caseId: CASE_ID,
      system: "us" as const,
      payload: {
        system: "us",
        gpaScale: 4,
        unweightedGpa: 3.5,
        fourYearCoursePlan: [],
      },
      effectiveDate: "2026-05-01",
      deletedAt: null,
      createdAt: new Date("2026-05-01T00:00:00Z"),
      updatedAt: new Date("2026-05-01T00:00:00Z"),
    };
    const imported: AdmissionsWorkbookPreview["canonicalAcademicRecords"] = [{
      system: "us",
      gpaScale: 4,
      unweightedGpa: 3.9,
      fourYearCoursePlan: [],
    }];

    const preserved = fakeDb([[], [existing]]);
    const preserveResult = await commitAdmissionsWorkbookPreview(commitInput(preview({
      canonicalAcademicRecords: imported,
    })), preserved.db);
    expect(preserveResult.summary.academic_record).toBe(1);
    expect(preserved.inserts.filter((call) => call.table === admissionsAcademicRecords)).toHaveLength(0);
    expect(preserved.updates.filter((call) => call.table === admissionsAcademicRecords)).toHaveLength(0);
    expect(preserved.inserts.find((call) => call.table === admissionsImportMappings)?.values)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ targetId: existing.id, sourceKey: "us" }),
      ]));

    const overwritten = fakeDb([[], [existing]]);
    await commitAdmissionsWorkbookPreview({
      ...commitInput(preview({ canonicalAcademicRecords: imported })),
      conflictPolicy: "overwrite_existing",
    }, overwritten.db);
    expect(overwritten.inserts.filter((call) => call.table === admissionsAcademicRecords)).toHaveLength(0);
    expect(overwritten.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: admissionsAcademicRecords,
        set: expect.objectContaining({ payload: imported[0] }),
      }),
    ]));
  });

  it("does not replace an existing academic record under preserve-existing on the first import", async () => {
    const existingAcademic = {
      id: "55555555-5555-4555-8555-555555555555",
      caseId: CASE_ID,
      system: "us",
      payload: {
        system: "us",
        gpaScale: 4,
        unweightedGpa: 3.6,
        fourYearCoursePlan: [],
      },
      effectiveDate: "2026-07-10",
      deletedAt: null,
    };
    const { db, updates } = fakeDb([
      [],
      [existingAcademic],
      [],
    ]);

    await commitAdmissionsWorkbookPreview(commitInput(preview({
      profile: { gpa_unweighted: "3.9 / 4.0" },
    })), db);

    expect(updates.some((call) => call.table === admissionsAcademicRecords)).toBe(false);
  });

  it("stores imported activity variants with canonical Common App and UC keys", async () => {
    const { db, inserts } = fakeDb([[], []]);

    await commitAdmissionsWorkbookPreview(commitInput(preview({
      activities: [{
        name: "Robotics",
        fullDescription: "Built an autonomous robot.",
        gradeLevels: ["10", "11"],
        hoursPerWeek: 8,
        weeksPerYear: 30,
        commonApp: {
          position: "Captain",
          organization: "Robotics Club",
          description: "Led design and programming.",
        },
        uc: {
          category: "Extracurricular Activity",
          description: "Team leadership and engineering.",
        },
      }],
    })), db);

    const activity = inserts.find((call) => call.table === admissionsActivities);
    expect(activity?.values).toMatchObject({
      commonApp: {
        position: "Captain",
        organization: "Robotics Club",
        description: "Led design and programming.",
        grades: ["10", "11"],
        hrsWeek: 8,
        weeksYear: 30,
      },
      uc: {
        category: "extracurricular_activity",
        description: "Team leadership and engineering.",
      },
    });
    expect(activity?.values).not.toHaveProperty("commonApp.gradeLevels");
    expect(activity?.values).not.toHaveProperty("commonApp.hoursPerWeek");
    expect(activity?.values).not.toHaveProperty("commonApp.weeksPerYear");
  });

  it("rejects an import that would exceed 20 live activities across existing and new rows", async () => {
    const existingActivities = Array.from({ length: 20 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      caseId: CASE_ID,
      name: `Existing activity ${index + 1}`,
      deletedAt: null,
    }));
    const { db, inserts, state } = fakeDb([[], existingActivities]);

    await expect(commitAdmissionsWorkbookPreview(commitInput(preview({
      activities: [{
        name: "One too many",
        fullDescription: null,
        gradeLevels: [],
        hoursPerWeek: null,
        weeksPerYear: null,
        commonApp: null,
        uc: null,
      }],
    })), db)).rejects.toMatchObject({
      name: "AdmissionsImportValidationError",
      issues: [expect.objectContaining({ code: "activity_limit_exceeded" })],
    });

    expect(inserts.some((call) => call.table === admissionsActivities)).toBe(false);
    expect(state()).toEqual({ committed: false, rolledBack: true });
  });

  it("does not create canonical events or lifecycle changes for undated legacy decisions", async () => {
    const { db, inserts, updates } = fakeDb([
      [],
      [],
    ]);

    await commitAdmissionsWorkbookPreview(commitInput(preview({
      applications: [{
        collegeName: "Example University",
        overallStatus: "Complete",
        deadline: "2026-11-01",
        round: "EA",
        admissionsUrl: "https://example.edu/admissions",
        firstChoiceMajor: "Computer Science",
        secondChoiceMajor: null,
        collegeQuestionsStatus: null,
        essayStatus: null,
        testStatus: null,
        recommendationStatus: null,
        transcriptStatus: null,
        demonstratedInterestPolicy: null,
        demonstratedInterestWays: null,
        honorsProgramStatus: null,
        interviewStatus: null,
        portfolioStatus: null,
        scholarshipStatus: null,
        financialAidStatus: null,
        financialAidDeadline: null,
        fafsaStatus: null,
        decision: "Accepted",
        portalUrl: "https://portal.example.edu",
        acceptedProgram: "BS Computer Science",
        scholarshipType: null,
        scholarshipAmount: null,
        studentDecision: "Committed — deposit paid",
        notes: null,
      }],
    })), db);

    const college = inserts.find((call) => call.table === admissionsCollegeListItems);
    expect(college).toBeDefined();
    const events = inserts.filter((call) => call.table === admissionsApplicationEvents);
    expect(events).toEqual([]);
    expect(updates.some((call) => call.table === admissionsCases)).toBe(false);
    expect(college?.values).not.toMatchObject({
      aidNotes: expect.stringMatching(/Accepted|Committed|deposit paid/),
    });
  });

  it("maps recognized transcript status to the canonical college document source", async () => {
    const { db, inserts } = fakeDb([
      [],
      [],
      [],
    ]);

    const result = await commitAdmissionsWorkbookPreview(commitInput(preview({
      applications: [{
        collegeName: "Example University",
        overallStatus: "Complete",
        deadline: "2026-11-01",
        round: "EA",
        admissionsUrl: null,
        firstChoiceMajor: null,
        secondChoiceMajor: null,
        collegeQuestionsStatus: null,
        essayStatus: null,
        testStatus: null,
        recommendationStatus: null,
        transcriptStatus: "Submitted",
        demonstratedInterestPolicy: null,
        demonstratedInterestWays: null,
        honorsProgramStatus: null,
        interviewStatus: null,
        portfolioStatus: null,
        scholarshipStatus: null,
        financialAidStatus: null,
        financialAidDeadline: null,
        fafsaStatus: null,
        decision: null,
        portalUrl: null,
        acceptedProgram: null,
        scholarshipType: null,
        scholarshipAmount: null,
        studentDecision: null,
        notes: null,
      }],
    })), db);

    expect(result.summary).toMatchObject({ college_list_item: 1, college_doc: 1 });
    expect(inserts.find((call) => call.table === admissionsCollegeDocs)?.values).toMatchObject({
      docType: "transcript",
      testSittingId: null,
      sent: true,
    });
    expect(inserts.find((call) => call.table === admissionsImportMappings)?.values)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          sourceType: "application_transcript_status",
          targetType: "college_doc",
        }),
      ]));
  });

  it("reuses a stable prior mapping when a changed-source task mutates its natural key", async () => {
    const previousRunId = "55555555-5555-4555-8555-555555555555";
    const taskId = "66666666-6666-4666-8666-666666666666";
    const { db, inserts, updates } = fakeDb([
      [{
        id: previousRunId,
        spreadsheetId: "sheet-id-12345678901234567890",
        sourceFingerprint: "b".repeat(64),
        status: "committed",
        committedAt: new Date("2026-07-01T00:00:00Z"),
        createdAt: new Date("2026-07-01T00:00:00Z"),
        summary: { task: 1 },
      }],
      [{
        runId: previousRunId,
        sourceType: "task",
        sourceKey: "Tasks!A7:L7",
        targetType: "task",
        targetId: taskId,
      }],
      [{
        id: taskId,
        caseId: CASE_ID,
        title: "Original task title",
        dueDate: "2026-10-01",
        deletedAt: null,
      }],
    ]);

    await commitAdmissionsWorkbookPreview({
      ...commitInput(preview({
        tasks: [{
          sourceRef: "Tasks!A7:L7",
          title: "Renamed task",
          status: "Started",
          topic: null,
          instructions: "Updated instructions",
          resourceUrl: null,
          notes: null,
          startDate: null,
          dueDate: "2026-10-15",
        }],
      })),
      conflictPolicy: "overwrite_existing",
    }, db);

    expect(inserts.some((call) => call.table === admissionsCaseTasks)).toBe(false);
    expect(updates).toContainEqual(expect.objectContaining({
      table: admissionsCaseTasks,
      set: expect.objectContaining({
        title: "Renamed task",
        dueDate: "2026-10-15",
      }),
    }));
    expect(inserts.find((call) => call.table === admissionsImportMappings)?.values)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          sourceType: "task",
          sourceKey: "Tasks!A7:L7",
          targetType: "task",
          targetId: taskId,
        }),
      ]));
  });

  it("returns a no-op for the same case, sheet, and fingerprint", async () => {
    const committedRun = {
      id: RUN_ID,
      caseId: CASE_ID,
      spreadsheetId: "sheet-id-12345678901234567890",
      sourceFingerprint: FINGERPRINT,
      status: "committed",
      summary: { task: 4 },
    };
    const { db, inserts } = fakeDb([[committedRun]]);

    const result = await commitAdmissionsWorkbookPreview(commitInput(preview()), db);

    expect(result).toEqual({
      runId: RUN_ID,
      status: "committed",
      noOp: true,
      sourceFingerprint: FINGERPRINT,
      summary: { task: 4 },
    });
    expect(inserts).toEqual([]);
  });

  it("turns a concurrent unique-key winner into an idempotent no-op", async () => {
    const racedRun = {
      id: RUN_ID,
      caseId: CASE_ID,
      spreadsheetId: "sheet-id-12345678901234567890",
      sourceFingerprint: FINGERPRINT,
      status: "committed",
      summary: { activity: 3 },
    };
    const { db } = fakeDb([[], [racedRun]], { runInsertConflict: true });

    const result = await commitAdmissionsWorkbookPreview(commitInput(preview()), db);

    expect(result).toEqual({
      runId: RUN_ID,
      status: "committed",
      noOp: true,
      sourceFingerprint: FINGERPRINT,
      summary: { activity: 3 },
    });
  });

  it("requires a conflict policy when the same workbook has a changed committed version", async () => {
    const { db, inserts } = fakeDb([[
      {
        id: RUN_ID,
        spreadsheetId: "sheet-id-12345678901234567890",
        sourceFingerprint: "b".repeat(64),
        status: "committed",
        summary: {},
      },
    ]]);

    await expect(commitAdmissionsWorkbookPreview({
      ...commitInput(preview()),
      conflictPolicy: undefined,
    }, db)).rejects.toBeInstanceOf(AdmissionsImportConflictChoiceRequiredError);
    expect(inserts).toEqual([]);
  });

  it("rejects source drift and blocking validation issues before opening a transaction", async () => {
    const transaction = vi.fn();
    const db = { transaction } as never;
    await expect(commitAdmissionsWorkbookPreview({
      ...commitInput(preview({ sourceFingerprint: "b".repeat(64) })),
    }, db)).rejects.toBeInstanceOf(AdmissionsImportSourceChangedError);
    await expect(commitAdmissionsWorkbookPreview(commitInput(preview({
      issues: [{
        severity: "error",
        code: "character_limit_violation",
        sheetName: "Activities -",
        range: "Award 1",
        message: "Narrative is too long.",
      }],
    })), db)).rejects.toBeInstanceOf(AdmissionsImportValidationError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rolls back the entire import when the append-only audit insert fails", async () => {
    const { db, state } = fakeDb([[]], { failAudit: true });

    await expect(commitAdmissionsWorkbookPreview(commitInput(preview()), db))
      .rejects.toThrow("audit insert failed");

    expect(state()).toEqual({ committed: false, rolledBack: true });
  });
});
