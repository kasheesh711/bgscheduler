import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import * as schema from "@/lib/db/schema";
import {
  AdmissionsImportConflictChoiceRequiredError,
  commitAdmissionsWorkbookPreview,
} from "@/lib/admissions/workbook-import-commit";
import type { AdmissionsWorkbookPreview } from "@/lib/admissions/workbook-import";

let handle: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  handle = await startTestDb();
}, 60_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

async function seedCase() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [cohort] = await handle.db.insert(schema.admissionsCohorts).values({
    name: `Workbook import cohort ${suffix}`,
    graduationYear: 2027,
  }).returning();
  const [student] = await handle.db.insert(schema.admissionsStudents).values({
    fullName: "Legacy Import Student",
    studentEmail: `legacy-${suffix}@example.com`,
    cohortId: cohort.id,
  }).returning();
  const [admissionsCase] = await handle.db.insert(schema.admissionsCases).values({
    studentId: student.id,
    cohortId: cohort.id,
  }).returning();
  return admissionsCase;
}

function preview(input: {
  spreadsheetId: string;
  sourceFingerprint: string;
  awardNarrative?: string;
}): AdmissionsWorkbookPreview {
  return {
    spreadsheetId: input.spreadsheetId,
    sourceFingerprint: input.sourceFingerprint,
    sourceTitle: "Legacy Student Copy",
    profile: { legal_name: "Legacy Import Student", citizenship: "Thailand" },
    academics: {},
    canonicalAcademicRecords: [],
    collegeCriteria: {},
    majorsCareers: {},
    meetings: [],
    tasks: [{
      title: "Submit school profile",
      status: "In progress",
      topic: "Academics",
      instructions: null,
      resourceUrl: null,
      notes: null,
      startDate: null,
      dueDate: "2026-10-01",
    }],
    activities: [],
    awards: input.awardNarrative ? [{
      title: "Imported award",
      organization: null,
      gradeLevels: ["11"],
      recognitionLevels: [],
      eligibilityNarrative: input.awardNarrative,
      achievementNarrative: null,
    }] : [],
    tests: [],
    research: [{
      collegeName: "Example University",
      sources: ["Official website"],
      fitAssessment: "Strong fit",
      academicNotes: "Good program",
      generalNotes: null,
      campusVisitNotes: null,
      questions: "How accessible is advising?",
    }],
    interestEvents: [],
    applications: [{
      collegeName: "Example University",
      overallStatus: "Applying",
      deadline: "2026-11-01",
      round: "EA",
      admissionsUrl: "https://example.edu/admissions",
      firstChoiceMajor: "Computer Science",
      secondChoiceMajor: null,
      collegeQuestionsStatus: "In progress",
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
      portalUrl: "https://portal.example.edu",
      acceptedProgram: null,
      scholarshipType: null,
      scholarshipAmount: null,
      studentDecision: null,
      notes: null,
    }],
    essayPrompts: [],
    financialAid: [],
    scholarships: [],
    issues: [],
    changes: [],
    counts: {},
  };
}

describe("legacy workbook import — real Postgres", () => {
  it("serializes different fingerprints for the same case and workbook", async () => {
    const admissionsCase = await seedCase();
    const spreadsheetId = "concurrent-sheet-12345678901234567890";
    const firstPreview = preview({
      spreadsheetId,
      sourceFingerprint: "1".repeat(64),
    });
    const secondPreview = preview({
      spreadsheetId,
      sourceFingerprint: "2".repeat(64),
    });
    const access = {
      caseId: admissionsCase.id,
      email: "counselor@example.com",
      role: "counselor" as const,
      isAdmin: false,
    };
    const commit = (workbook: AdmissionsWorkbookPreview) =>
      commitAdmissionsWorkbookPreview({
        access,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        expectedFingerprint: workbook.sourceFingerprint,
        conflictPolicy: undefined,
        preview: workbook,
      }, handle.db as never);

    const results = await Promise.allSettled([
      commit(firstPreview),
      commit(secondPreview),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(AdmissionsImportConflictChoiceRequiredError),
    });
    const runs = await handle.db.select().from(schema.admissionsImportRuns).where(and(
      eq(schema.admissionsImportRuns.caseId, admissionsCase.id),
      eq(schema.admissionsImportRuns.spreadsheetId, spreadsheetId),
    ));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("committed");
  });

  it("writes canonical profile and US academics without changing the login email", async () => {
    const admissionsCase = await seedCase();
    const sourceFingerprint = "c".repeat(64);
    const spreadsheetId = "canonical-sheet-12345678901234567890";
    const workbook = preview({ spreadsheetId, sourceFingerprint });
    workbook.profile = {
      legal_name: "Canonical Taylor Student",
      preferred_name: "Tay",
      personal_email: "legacy-personal@example.com",
      primary_phone: "+66 81 234 5678",
      current_school: "International School Bangkok",
      gpa_unweighted: "3.84 / 4.0",
      gpa_weighted: "4.36",
      class_rank: "11",
      class_size: "175",
    };
    workbook.academics = {
      ib_predicted_total: "42",
      a_level_subjects: "Mathematics, Physics",
    };

    const before = await handle.db.select().from(schema.admissionsStudents)
      .where(eq(schema.admissionsStudents.id, admissionsCase.studentId));
    const loginEmail = before[0]!.studentEmail;
    const result = await commitAdmissionsWorkbookPreview({
      access: {
        caseId: admissionsCase.id,
        email: "counselor@example.com",
        role: "counselor",
        isAdmin: false,
      },
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      expectedFingerprint: sourceFingerprint,
      conflictPolicy: "preserve_existing",
      preview: workbook,
    }, handle.db as never);

    const [students, academicRecords, sectionRows, mappingRows, auditRows] = await Promise.all([
      handle.db.select().from(schema.admissionsStudents)
        .where(eq(schema.admissionsStudents.id, admissionsCase.studentId)),
      handle.db.select().from(schema.admissionsAcademicRecords)
        .where(eq(schema.admissionsAcademicRecords.caseId, admissionsCase.id)),
      handle.db.select().from(schema.admissionsSelfReportSections)
        .where(eq(schema.admissionsSelfReportSections.caseId, admissionsCase.id)),
      handle.db.select().from(schema.admissionsImportMappings)
        .where(eq(schema.admissionsImportMappings.runId, result.runId)),
      handle.db.select().from(schema.admissionsAuditLog)
        .where(eq(schema.admissionsAuditLog.caseId, admissionsCase.id)),
    ]);

    expect(students[0]).toMatchObject({
      fullName: "Canonical Taylor Student",
      preferredName: "Tay",
      studentEmail: loginEmail,
      phone: "+66 81 234 5678",
      school: "International School Bangkok",
    });
    expect(students[0]?.studentEmail).not.toBe("legacy-personal@example.com");
    expect(academicRecords).toHaveLength(1);
    expect(academicRecords[0]?.payload).toEqual({
      system: "us",
      gpaScale: 4,
      unweightedGpa: 3.84,
      weightedGpa: 4.36,
      classRank: 11,
      classSize: 175,
      fourYearCoursePlan: [],
    });
    expect(sectionRows.find((row) => row.sectionKey === "about_you")?.payload)
      .toMatchObject({ personal_email: "legacy-personal@example.com" });
    expect(sectionRows.find((row) => row.sectionKey === "legacy_academics")?.payload)
      .toEqual(workbook.academics);
    expect(mappingRows.map((row) => row.targetType)).toEqual(expect.arrayContaining([
      "student_profile",
      "academic_record",
      "self_report_section",
    ]));
    expect(auditRows.map((row) => row.entityType)).toEqual(expect.arrayContaining([
      "student",
      "academic_record",
      "workbook_import",
    ]));
  });

  it("commits entity mappings atomically and repeats the same fingerprint as a no-op", async () => {
    const admissionsCase = await seedCase();
    const sourceFingerprint = "a".repeat(64);
    const workbook = preview({
      spreadsheetId: "integration-sheet-12345678901234567890",
      sourceFingerprint,
    });
    const input = {
      access: {
        caseId: admissionsCase.id,
        email: "counselor@example.com",
        role: "counselor" as const,
        isAdmin: false,
      },
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/integration-sheet-12345678901234567890/edit",
      expectedFingerprint: sourceFingerprint,
      conflictPolicy: "preserve_existing" as const,
      preview: workbook,
    };

    const first = await commitAdmissionsWorkbookPreview(input, handle.db as never);
    expect(first.noOp).toBe(false);
    expect(first.summary).toEqual(expect.objectContaining({
      self_report_section: 1,
      task: 1,
      college_list_item: 1,
      college_research: 1,
      college_requirement: 1,
    }));

    const [runRows, mappingRows, sectionRows, auditRows] = await Promise.all([
      handle.db.select().from(schema.admissionsImportRuns).where(eq(schema.admissionsImportRuns.id, first.runId)),
      handle.db.select().from(schema.admissionsImportMappings).where(eq(schema.admissionsImportMappings.runId, first.runId)),
      handle.db.select().from(schema.admissionsSelfReportSections).where(eq(schema.admissionsSelfReportSections.caseId, admissionsCase.id)),
      handle.db.select().from(schema.admissionsAuditLog).where(and(
        eq(schema.admissionsAuditLog.caseId, admissionsCase.id),
        eq(schema.admissionsAuditLog.entityType, "workbook_import"),
      )),
    ]);
    expect(runRows[0]?.status).toBe("committed");
    expect(mappingRows.length).toBeGreaterThanOrEqual(5);
    expect(sectionRows).toHaveLength(1);
    expect(auditRows).toHaveLength(1);

    const second = await commitAdmissionsWorkbookPreview(input, handle.db as never);
    expect(second).toEqual(expect.objectContaining({
      runId: first.runId,
      noOp: true,
    }));
    const allRuns = await handle.db.select().from(schema.admissionsImportRuns).where(and(
      eq(schema.admissionsImportRuns.caseId, admissionsCase.id),
      eq(schema.admissionsImportRuns.spreadsheetId, workbook.spreadsheetId),
    ));
    expect(allRuns).toHaveLength(1);
  });

  it("rolls the run and every earlier entity write back when a later constraint fails", async () => {
    const admissionsCase = await seedCase();
    const sourceFingerprint = "b".repeat(64);
    const spreadsheetId = "rollback-sheet-12345678901234567890";
    const workbook = preview({
      spreadsheetId,
      sourceFingerprint,
      // Bypass the preview-builder guard deliberately so Postgres rejects the
      // award after the run/section/task writes have already been attempted.
      awardNarrative: "x".repeat(251),
    });

    await expect(commitAdmissionsWorkbookPreview({
      access: {
        caseId: admissionsCase.id,
        email: "counselor@example.com",
        role: "counselor",
        isAdmin: false,
      },
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      expectedFingerprint: sourceFingerprint,
      conflictPolicy: "preserve_existing",
      preview: workbook,
    }, handle.db as never)).rejects.toThrow();

    const [runs, sections, tasks, awards] = await Promise.all([
      handle.db.select().from(schema.admissionsImportRuns).where(and(
        eq(schema.admissionsImportRuns.caseId, admissionsCase.id),
        eq(schema.admissionsImportRuns.spreadsheetId, spreadsheetId),
      )),
      handle.db.select().from(schema.admissionsSelfReportSections).where(eq(schema.admissionsSelfReportSections.caseId, admissionsCase.id)),
      handle.db.select().from(schema.admissionsCaseTasks).where(eq(schema.admissionsCaseTasks.caseId, admissionsCase.id)),
      handle.db.select().from(schema.admissionsAwards).where(eq(schema.admissionsAwards.caseId, admissionsCase.id)),
    ]);
    expect(runs).toHaveLength(0);
    expect(sections).toHaveLength(0);
    expect(tasks).toHaveLength(0);
    expect(awards).toHaveLength(0);
  });
});
