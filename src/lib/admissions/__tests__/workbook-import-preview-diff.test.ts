import { describe, expect, it } from "vitest";

import {
  admissionsActivities,
  admissionsCaseTasks,
  admissionsImportMappings,
  admissionsImportRuns,
} from "@/lib/db/schema";
import { appendAdmissionsWorkbookEntityChanges } from "../workbook-import-preview-diff";
import type { AdmissionsWorkbookPreview } from "../workbook-import";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

function preview(overrides: Partial<AdmissionsWorkbookPreview> = {}): AdmissionsWorkbookPreview {
  return {
    spreadsheetId: "sheet-id-12345678901234567890",
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
    ...overrides,
  };
}

function fakeDb(rowsByTable: Map<unknown, unknown[]>) {
  return {
    select: () => {
      let table: unknown;
      const builder: Record<string, unknown> = {};
      builder.from = (nextTable: unknown) => {
        table = nextTable;
        return builder;
      };
      for (const method of ["where", "orderBy", "limit", "innerJoin"]) {
        builder[method] = () => builder;
      }
      (builder as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(rowsByTable.get(table) ?? []).then(resolve, reject);
      return builder;
    },
  } as never;
}

describe("workbook import entity preview diffs", () => {
  it("uses the latest stable source mapping when mutable task fields change", async () => {
    const workbookPreview = preview({
      tasks: [{
        sourceRef: "Tasks!A7:L7",
        title: "Rewritten task title",
        status: "Started",
        topic: null,
        instructions: "Updated instructions",
        resourceUrl: null,
        notes: null,
        startDate: null,
        dueDate: "2026-10-15",
      }],
    });
    const db = fakeDb(new Map<unknown, unknown[]>([
      [admissionsImportRuns, [{
        id: RUN_ID,
        committedAt: new Date("2026-07-01T00:00:00Z"),
        createdAt: new Date("2026-07-01T00:00:00Z"),
      }]],
      [admissionsImportMappings, [{
        runId: RUN_ID,
        sourceType: "task",
        sourceKey: "Tasks!A7:L7",
        targetType: "task",
        targetId: TASK_ID,
      }]],
      [admissionsCaseTasks, [{
        id: TASK_ID,
        caseId: CASE_ID,
        phase: "about_you",
        title: "Original task title",
        description: "Original instructions",
        owner: "student",
        status: "not_started",
        dueDate: "2026-10-15",
        sortOrder: 0,
      }]],
    ]));

    await appendAdmissionsWorkbookEntityChanges({ db, caseId: CASE_ID, preview: workbookPreview });

    expect(workbookPreview.changes).toEqual(expect.arrayContaining([
      {
        target: "task:Tasks!A7:L7",
        field: "title",
        oldValue: "Original task title",
        newValue: "Rewritten task title",
      },
      {
        target: "task:Tasks!A7:L7",
        field: "description",
        oldValue: "Original instructions",
        newValue: "Updated instructions",
      },
    ]));
    expect(workbookPreview.changes.find((change) => change.field === "title")?.oldValue)
      .not.toBeNull();
  });

  it("counts a renamed mapped activity as the same live record", async () => {
    const activityRows = Array.from({ length: 20 }, (_, index) => ({
      id: index === 0
        ? TASK_ID
        : `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      caseId: CASE_ID,
      name: `Existing activity ${index + 1}`,
      fullDescription: null,
      commonApp: {},
      uc: null,
      sortOrder: index,
    }));
    const workbookPreview = preview({
      activities: [{
        sourceRef: "Activities -!A4:U15",
        name: "Renamed mapped activity",
        fullDescription: null,
        gradeLevels: [],
        hoursPerWeek: null,
        weeksPerYear: null,
        commonApp: null,
        uc: null,
      }],
    });
    const db = fakeDb(new Map<unknown, unknown[]>([
      [admissionsImportRuns, [{
        id: RUN_ID,
        committedAt: new Date("2026-07-01T00:00:00Z"),
        createdAt: new Date("2026-07-01T00:00:00Z"),
      }]],
      [admissionsImportMappings, [{
        runId: RUN_ID,
        sourceType: "activity",
        sourceKey: "Activities -!A4:U15",
        targetType: "activity",
        targetId: TASK_ID,
      }]],
      [admissionsActivities, activityRows],
    ]));

    await appendAdmissionsWorkbookEntityChanges({ db, caseId: CASE_ID, preview: workbookPreview });

    expect(workbookPreview.counts.liveActivitiesAfterImport).toBe(20);
    expect(workbookPreview.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "activity_limit_exceeded" }),
    ]));
  });

  it("warns without deleting when a previously imported source row disappears", async () => {
    const workbookPreview = preview();
    const db = fakeDb(new Map<unknown, unknown[]>([
      [admissionsImportRuns, [{
        id: RUN_ID,
        committedAt: new Date("2026-07-01T00:00:00Z"),
        createdAt: new Date("2026-07-01T00:00:00Z"),
      }]],
      [admissionsImportMappings, [{
        runId: RUN_ID,
        sourceType: "task",
        sourceKey: "Tasks!A7:L7",
        targetType: "task",
        targetId: TASK_ID,
      }]],
      [admissionsCaseTasks, [{ id: TASK_ID, caseId: CASE_ID, title: "Keep me" }]],
    ]));

    await appendAdmissionsWorkbookEntityChanges({ db, caseId: CASE_ID, preview: workbookPreview });

    expect(workbookPreview.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "warning",
        code: "previously_imported_source_missing",
        sheetName: "Tasks",
        range: "Tasks!A7:L7",
        message: expect.stringContaining("delete it manually"),
      }),
    ]));
    expect(workbookPreview.changes).toEqual([]);
  });

  it("exposes field-level changes for every mutable imported entity group", async () => {
    const application = {
      sourceRef: "ApplicationTracker!D33:DD33",
      collegeName: "Example University",
      overallStatus: "Applying",
      deadline: "2026-11-01",
      round: "EA",
      admissionsUrl: "https://example.edu/admissions",
      firstChoiceMajor: "Physics",
      secondChoiceMajor: null,
      collegeQuestionsStatus: "Started",
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
    };
    const workbookPreview = preview({
      tasks: [{
        sourceRef: "Tasks!A3:L3",
        title: "Submit profile",
        status: "Started",
        topic: null,
        instructions: "Complete every field",
        resourceUrl: null,
        notes: null,
        startDate: null,
        dueDate: "2026-08-01",
      }],
      activities: [{
        sourceRef: "Activities -!A4:U15",
        name: "Robotics",
        fullDescription: "Built robots",
        gradeLevels: ["10"],
        hoursPerWeek: 5,
        weeksPerYear: 20,
        commonApp: null,
        uc: null,
      }],
      awards: [{
        sourceRef: "Activities -!A16:U27",
        title: "Science Prize",
        organization: "School",
        gradeLevels: ["11"],
        recognitionLevels: ["school"],
        eligibilityNarrative: "Top project",
        achievementNarrative: "Won first place",
      }],
      tests: [{
        sourceRef: "Tests!H41:P41",
        testType: "ap",
        testDate: "2026-05-01",
        subject: "Physics C",
        scoreDetails: { score: 5 },
      }],
      research: [{
        sourceRef: "Research Notes!A3:I10",
        collegeName: "Example University",
        sources: ["Website"],
        fitAssessment: "Strong",
        academicNotes: "Excellent physics",
        generalNotes: null,
        campusVisitNotes: null,
        questions: "Research options?",
      }],
      applications: [application],
      essayPrompts: [{
        sourceRef: "Essay Prompts!R3C5:R3C6",
        collegeName: "Example University",
        prompt: "Why us?",
        status: "Drafting",
        sourceUrl: null,
      }],
      financialAid: [{
        sourceRef: " FinAidComparisons!column:3",
        collegeName: "Example University",
        cost: { tuitionFees: 50_000 },
        giftAid: { collegeGrants: 10_000 },
        loans: { workStudy: 2_000 },
        remainingBalance: 38_000,
      }],
      scholarships: [{
        sourceRef: "ScholarshipTracker!A3:J3",
        name: "STEM Award",
        provider: "Foundation",
        providerAddress: null,
        contact: null,
        deadline: "2026-09-01",
        submittedDate: null,
        outcome: null,
        notes: "Needs recommendation",
      }],
    });

    await appendAdmissionsWorkbookEntityChanges({
      db: fakeDb(new Map()),
      caseId: CASE_ID,
      preview: workbookPreview,
    });

    const targets = new Set(workbookPreview.changes.map((change) => change.target.split(":")[0]));
    expect([...targets]).toEqual(expect.arrayContaining([
      "task",
      "activity",
      "award",
      "test_sitting",
      "college_research",
      "college_requirement",
      "essay",
      "financial_aid",
      "scholarship",
    ]));
  });
});
