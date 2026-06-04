import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StudentPromotionRunDetail } from "@/lib/student-promotions/data";
import {
  ALL_TARGET_GRADES_FILTER,
  NO_TARGET_GRADE_FILTER,
  StudentPromotionsWorkspace,
  buildStudentTargetGradeMap,
  buildTargetGradeFilterOptions,
  courseRowsForCsv,
  filterCourseActionsByTargetGrade,
  filterGradeActionsByTargetGrade,
  gradeRowsForCsv,
} from "../student-promotions-workspace";

type GradeAction = StudentPromotionRunDetail["gradeActions"][number];
type CourseAction = StudentPromotionRunDetail["courseActions"][number];

const now = new Date("2026-06-04T00:00:00.000Z");

function gradeAction(overrides: Partial<GradeAction> = {}): GradeAction {
  return {
    id: overrides.id ?? "grade-1",
    runId: overrides.runId ?? "run-1",
    wiseStudentId: overrides.wiseStudentId ?? "student-1",
    studentName: overrides.studentName ?? "Ada Li",
    studentKey: overrides.studentKey ?? "ada li::parent li",
    currentGradeRaw: overrides.currentGradeRaw ?? "Year 8",
    parsedCurrentYear: overrides.parsedCurrentYear ?? 8,
    targetGrade: overrides.targetGrade === undefined ? "Year 9 / Grade 8" : overrides.targetGrade,
    actionType: overrides.actionType ?? "year8_course_and_grade",
    status: overrides.status ?? "pending",
    skipReason: overrides.skipReason ?? null,
    requestPayload: overrides.requestPayload ?? null,
    responsePayload: overrides.responsePayload ?? null,
    errorMessage: overrides.errorMessage ?? null,
    appliedAt: overrides.appliedAt ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function courseAction(overrides: Partial<CourseAction> = {}): CourseAction {
  return {
    id: overrides.id ?? "course-1",
    runId: overrides.runId ?? "run-1",
    wiseClassId: overrides.wiseClassId ?? "class-1",
    currentSubject: overrides.currentSubject ?? "Y2-8 / G1-7 (Int.)",
    targetSubject: overrides.targetSubject ?? "Y9-11 / G8-10 (Int.)",
    transitionType: overrides.transitionType ?? "year8_to_year9",
    studentIds: overrides.studentIds ?? ["student-1"],
    qualifyingStudentIds: overrides.qualifyingStudentIds ?? ["student-1"],
    status: overrides.status ?? "pending",
    skipReason: overrides.skipReason ?? null,
    requestPayload: overrides.requestPayload ?? null,
    responsePayload: overrides.responsePayload ?? null,
    errorMessage: overrides.errorMessage ?? null,
    appliedAt: overrides.appliedAt ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function detail(overrides: Partial<StudentPromotionRunDetail> = {}): StudentPromotionRunDetail {
  const gradeActions = overrides.gradeActions ?? [
    gradeAction({ id: "grade-y9", wiseStudentId: "student-y9", targetGrade: "Year 9 / Grade 8" }),
    gradeAction({ id: "grade-y12", wiseStudentId: "student-y12", targetGrade: "Year 12 / Grade 11" }),
    gradeAction({
      id: "grade-review",
      wiseStudentId: "student-review",
      targetGrade: null,
      parsedCurrentYear: null,
      status: "skipped",
      actionType: "missing_grade_review",
      skipReason: "missing_grade_review",
    }),
  ];
  const courseActions = overrides.courseActions ?? [
    courseAction({ id: "course-y9", wiseClassId: "class-y9", studentIds: ["student-y9"], qualifyingStudentIds: ["student-y9"] }),
    courseAction({ id: "course-y12", wiseClassId: "class-y12", studentIds: ["student-y12"], qualifyingStudentIds: ["student-y12"] }),
  ];

  return {
    run: {
      id: "run-1",
      targetDate: "2026-07-01",
      status: "draft",
      sourceSnapshotId: "snapshot-1",
      wiseAcceptedStudentCount: gradeActions.length,
      websiteSnapshotStudentCount: gradeActions.length,
      gradeOnlyCount: 0,
      year8CourseMoveCount: 1,
      year11CourseMoveCount: 1,
      skippedGradeCount: gradeActions.filter((row) => row.status === "skipped").length,
      pendingCourseActionCount: courseActions.filter((row) => row.status === "pending").length,
      skippedCourseActionCount: courseActions.filter((row) => row.status === "skipped").length,
      verifiedAt: null,
      verifiedByEmail: null,
      verifiedByName: null,
      endpointVerificationNote: null,
      applyStartedAt: null,
      applyFinishedAt: null,
      appliedByEmail: null,
      appliedByName: null,
      errorSummary: null,
      metadata: {},
      createdByEmail: "admin@example.com",
      createdByName: "Admin",
      createdAt: now,
      updatedAt: now,
    },
    gradeActions,
    courseActions,
    summary: {
      pendingGradeActions: gradeActions.filter((row) => row.status === "pending").length,
      skippedGradeActions: gradeActions.filter((row) => row.status === "skipped").length,
      appliedGradeActions: 0,
      failedGradeActions: 0,
      pendingCourseActions: courseActions.filter((row) => row.status === "pending").length,
      skippedCourseActions: courseActions.filter((row) => row.status === "skipped").length,
      appliedCourseActions: 0,
      failedCourseActions: 0,
    },
  };
}

describe("student promotion target-grade filter helpers", () => {
  it("builds sorted target-grade options and keeps no-target review rows last", () => {
    const rows = [
      gradeAction({ id: "y12", targetGrade: "Year 12 / Grade 11" }),
      gradeAction({ id: "review", targetGrade: null, parsedCurrentYear: null }),
      gradeAction({ id: "y9", targetGrade: "Year 9 / Grade 8" }),
      gradeAction({ id: "y9b", targetGrade: "Year 9 / Grade 8" }),
    ];

    expect(buildTargetGradeFilterOptions(rows)).toEqual([
      { value: ALL_TARGET_GRADES_FILTER, label: "All target grades", count: 4 },
      { value: "Year 9 / Grade 8", label: "Year 9 / Grade 8", count: 2 },
      { value: "Year 12 / Grade 11", label: "Year 12 / Grade 11", count: 1 },
      { value: NO_TARGET_GRADE_FILTER, label: "No target / needs review", count: 1 },
    ]);
  });

  it("filters pending and skipped grade rows by promoted target grade", () => {
    const rows = [
      gradeAction({ id: "pending-y9", status: "pending", targetGrade: "Year 9 / Grade 8" }),
      gradeAction({ id: "pending-y12", status: "pending", targetGrade: "Year 12 / Grade 11" }),
      gradeAction({ id: "review", status: "skipped", targetGrade: null, parsedCurrentYear: null }),
    ];

    expect(filterGradeActionsByTargetGrade(rows, "Year 9 / Grade 8").map((row) => row.id)).toEqual(["pending-y9"]);
    expect(filterGradeActionsByTargetGrade(rows, NO_TARGET_GRADE_FILTER).map((row) => row.id)).toEqual(["review"]);
    expect(filterGradeActionsByTargetGrade(rows, ALL_TARGET_GRADES_FILTER).map((row) => row.id)).toEqual([
      "pending-y9",
      "pending-y12",
      "review",
    ]);
  });

  it("includes course rows when roster or qualifying students match the selected target grade", () => {
    const grades = [
      gradeAction({ wiseStudentId: "student-y9", targetGrade: "Year 9 / Grade 8" }),
      gradeAction({ wiseStudentId: "student-y12", targetGrade: "Year 12 / Grade 11" }),
      gradeAction({ wiseStudentId: "student-review", targetGrade: null, parsedCurrentYear: null }),
    ];
    const courses = [
      courseAction({ id: "roster-y9", studentIds: ["student-y9"], qualifyingStudentIds: [] }),
      courseAction({ id: "qualifying-y12", studentIds: [], qualifyingStudentIds: ["student-y12"] }),
      courseAction({ id: "review", studentIds: ["student-review"], qualifyingStudentIds: [] }),
    ];
    const studentTargets = buildStudentTargetGradeMap(grades);

    expect(filterCourseActionsByTargetGrade(courses, "Year 9 / Grade 8", studentTargets).map((row) => row.id)).toEqual([
      "roster-y9",
    ]);
    expect(filterCourseActionsByTargetGrade(courses, "Year 12 / Grade 11", studentTargets).map((row) => row.id)).toEqual([
      "qualifying-y12",
    ]);
    expect(filterCourseActionsByTargetGrade(courses, NO_TARGET_GRADE_FILTER, studentTargets).map((row) => row.id)).toEqual([
      "review",
    ]);
  });

  it("keeps CSV exports as full-run exports", () => {
    const runDetail = detail();

    expect(gradeRowsForCsv(runDetail)).toBe(runDetail.gradeActions);
    expect(courseRowsForCsv(runDetail)).toBe(runDetail.courseActions);
  });
});

describe("StudentPromotionsWorkspace target-grade filter UI", () => {
  it("renders the target-grade control and full-run filtered count", () => {
    const html = renderToStaticMarkup(<StudentPromotionsWorkspace initialDetail={detail()} />);

    expect(html).toContain("Target grade");
    expect(html).toContain("Showing 3 of 3 grade actions");
  });
});
