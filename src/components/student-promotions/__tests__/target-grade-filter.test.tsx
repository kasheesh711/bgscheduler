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
  freshnessWarningsForDetail,
  futureSessionRowsForCsv,
  graduationRowsForCsv,
  gradeRowsForCsv,
  payRateImpactRowsForCsv,
  readbackRowsForCsv,
} from "../student-promotions-workspace";

type GradeAction = StudentPromotionRunDetail["gradeActions"][number];
type CourseAction = StudentPromotionRunDetail["courseActions"][number];
type FutureSessionAction = StudentPromotionRunDetail["futureSessionActions"][number];
type GraduationAction = StudentPromotionRunDetail["graduationActions"][number];
type PayRateImpact = StudentPromotionRunDetail["payRateImpacts"][number];

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

function futureSessionAction(overrides: Partial<FutureSessionAction> = {}): FutureSessionAction {
  return {
    id: overrides.id ?? "future-1",
    runId: overrides.runId ?? "run-1",
    courseActionId: overrides.courseActionId === undefined ? "course-1" : overrides.courseActionId,
    wiseClassId: overrides.wiseClassId ?? "class-1",
    wiseSessionId: overrides.wiseSessionId ?? "session-1",
    scheduledStartTime: overrides.scheduledStartTime ?? new Date("2026-07-01T03:00:00.000Z"),
    currentSubject: overrides.currentSubject ?? "Y2-8 / G1-7 (Int.)",
    targetSubject: overrides.targetSubject ?? "Y9-11 / G8-10 (Int.)",
    currentNormalizedCourseKey: overrides.currentNormalizedCourseKey ?? "year_2_8_grade_1_7",
    targetNormalizedCourseKey: overrides.targetNormalizedCourseKey ?? "year_9_11_grade_8_10",
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

function graduationAction(overrides: Partial<GraduationAction> = {}): GraduationAction {
  return {
    id: overrides.id ?? "graduation-1",
    runId: overrides.runId ?? "run-1",
    wiseStudentId: overrides.wiseStudentId ?? "student-13",
    studentName: overrides.studentName ?? "Iris Wong",
    parentName: overrides.parentName ?? "Parent Wong",
    studentKey: overrides.studentKey ?? "iris wong::parent wong",
    currentGradeRaw: overrides.currentGradeRaw ?? "Year 13",
    disposition: overrides.disposition ?? null,
    status: overrides.status ?? "pending_review",
    reviewedByEmail: overrides.reviewedByEmail ?? null,
    reviewedByName: overrides.reviewedByName ?? null,
    reviewedAt: overrides.reviewedAt ?? null,
    appliedAt: overrides.appliedAt ?? null,
    errorMessage: overrides.errorMessage ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function payRateImpact(overrides: Partial<PayRateImpact> = {}): PayRateImpact {
  return {
    id: overrides.id ?? "pay-1",
    runId: overrides.runId ?? "run-1",
    courseActionId: overrides.courseActionId ?? "course-y9",
    impactKey: overrides.impactKey ?? "impact-1",
    wiseClassId: overrides.wiseClassId ?? "class-y9",
    teacherWiseId: overrides.teacherWiseId ?? "teacher-doc-1",
    teacherWiseUserId: overrides.teacherWiseUserId ?? "teacher-user-1",
    teacherName: overrides.teacherName ?? "Tutor One",
    rawTier: overrides.rawTier ?? "Tier 1",
    normalizedTier: overrides.normalizedTier ?? "BG1",
    studentBand: overrides.studentBand ?? "1",
    currentSubject: overrides.currentSubject ?? "Y2-8 / G1-7 (Int.)",
    targetSubject: overrides.targetSubject ?? "Y9-11 / G8-10 (Int.)",
    currentNormalizedCourseKey: overrides.currentNormalizedCourseKey ?? "year_2_8_grade_1_7",
    targetNormalizedCourseKey: overrides.targetNormalizedCourseKey ?? "year_9_11_grade_8_10",
    beforeRateRuleId: overrides.beforeRateRuleId ?? "rule-before",
    afterRateRuleId: overrides.afterRateRuleId ?? "rule-after",
    beforeExpectedHourlyRate: overrides.beforeExpectedHourlyRate ?? 1000,
    afterExpectedHourlyRate: overrides.afterExpectedHourlyRate ?? 1200,
    rateDelta: overrides.rateDelta ?? 200,
    futureSessionCount: overrides.futureSessionCount ?? 3,
    firstSessionStartTime: overrides.firstSessionStartTime ?? new Date("2026-07-01T03:00:00.000Z"),
    lastSessionStartTime: overrides.lastSessionStartTime ?? new Date("2026-07-08T03:00:00.000Z"),
    affectedStudentIds: overrides.affectedStudentIds ?? ["student-y9"],
    affectedStudentNames: overrides.affectedStudentNames ?? ["Ada Li"],
    reviewStatus: overrides.reviewStatus ?? "pending_review",
    blockerReason: overrides.blockerReason ?? null,
    reviewedByEmail: overrides.reviewedByEmail ?? null,
    reviewedByName: overrides.reviewedByName ?? null,
    reviewedAt: overrides.reviewedAt ?? null,
    reviewNote: overrides.reviewNote ?? null,
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
  const futureSessionActions = overrides.futureSessionActions ?? [
    futureSessionAction({ id: "future-y9", wiseClassId: "class-y9", wiseSessionId: "session-y9" }),
  ];
  const graduationActions = overrides.graduationActions ?? [
    graduationAction(),
  ];
  const payRateImpacts = overrides.payRateImpacts ?? [
    payRateImpact(),
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
    futureSessionActions,
    graduationActions,
    payRateImpacts,
    freshness: overrides.freshness ?? {
      sourceSnapshotId: "snapshot-1",
      sourceSnapshotGeneratedAt: now,
      sourceSnapshotStudentCount: gradeActions.length,
      activeCreditControlSnapshotId: "snapshot-1",
      activeCreditControlSnapshotGeneratedAt: now,
      activeCreditControlStudentCount: gradeActions.length,
      activeSnapshotIsNewer: false,
      runIsOlderThan24Hours: false,
    },
    summary: {
      pendingGradeActions: gradeActions.filter((row) => row.status === "pending").length,
      skippedGradeActions: gradeActions.filter((row) => row.status === "skipped").length,
      appliedGradeActions: 0,
      failedGradeActions: 0,
      pendingCourseActions: courseActions.filter((row) => row.status === "pending").length,
      skippedCourseActions: courseActions.filter((row) => row.status === "skipped").length,
      appliedCourseActions: 0,
      failedCourseActions: 0,
      pendingFutureSessionActions: futureSessionActions.filter((row) => row.status === "pending").length,
      skippedFutureSessionActions: futureSessionActions.filter((row) => row.status === "skipped").length,
      appliedFutureSessionActions: futureSessionActions.filter((row) => row.status === "applied").length,
      failedFutureSessionActions: futureSessionActions.filter((row) => row.status === "failed").length,
      pendingGraduationActions: graduationActions.filter((row) => !row.disposition || row.status === "pending_review").length,
      inactiveGraduationActions: graduationActions.filter((row) => row.disposition === "inactive").length,
      universityGraduationActions: graduationActions.filter((row) => row.disposition === "university").length,
      appliedGraduationActions: graduationActions.filter((row) => row.status === "applied").length,
      failedGraduationActions: graduationActions.filter((row) => row.status === "failed").length,
      pendingPayRateImpacts: payRateImpacts.filter((row) => row.reviewStatus === "pending_review").length,
      verifiedPayRateImpacts: payRateImpacts.filter((row) => row.reviewStatus === "verified_correct").length,
      incorrectPayRateImpacts: payRateImpacts.filter((row) => row.reviewStatus === "incorrect").length,
      blockedPayRateImpacts: payRateImpacts.filter((row) => row.reviewStatus === "blocked" || row.blockerReason).length,
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
    expect(futureSessionRowsForCsv(runDetail)).toBe(runDetail.futureSessionActions);
    expect(graduationRowsForCsv(runDetail)).toBe(runDetail.graduationActions);
    expect(payRateImpactRowsForCsv(runDetail)[0]).toMatchObject({
      teacherName: "Tutor One",
      beforeExpectedHourlyRate: 1000,
      afterExpectedHourlyRate: 1200,
    });
    expect(readbackRowsForCsv({
      runId: "run-1",
      checkedAt: now,
      liveAcceptedStudentCount: 1,
      runGradeActionCount: 1,
      gradeSummary: {
        promoted_exact: 1,
        promoted_equivalent: 0,
        missing_from_run: 0,
        skipped_needs_review: 0,
        wrong_grade: 0,
        unparseable_grade: 0,
        fetch_failed: 0,
      },
      courseSummary: {
        target_matched: 1,
        skipped_needs_review: 0,
        subject_drift: 0,
        roster_drift: 0,
        fetch_failed: 0,
      },
      futureSessionSummary: {
        target_matched: 1,
        pending_update: 0,
        manual_required: 0,
        subject_drift: 0,
        missing_class_id: 0,
        missing_session_id: 0,
        failed: 0,
      },
      gradeRows: [{
        wiseStudentId: "student-1",
        studentName: "Ada Li",
        expectedTargetGrade: "Year 9 / Grade 8",
        expectedPromotedYear: 9,
        currentGradeRaw: "Year 9 / Grade 8",
        currentYear: 9,
        status: "promoted_exact",
        detail: null,
      }],
      courseRows: [{
        wiseClassId: "class-1",
        currentSubjectAtAudit: "Y2-8 / G1-7 (Int.)",
        expectedTargetSubject: "Y9-11 / G8-10 (Int.)",
        liveSubject: "Y9-11 / G8-10 (Int.)",
        status: "target_matched",
        detail: null,
      }],
      futureSessionRows: [{
        wiseClassId: "class-1",
        wiseSessionId: "session-1",
        courseActionId: "course-1",
        scheduledStartTime: "2026-07-01T03:00:00.000Z",
        currentSubjectAtAudit: "Y2-8 / G1-7 (Int.)",
        expectedTargetSubject: "Y9-11 / G8-10 (Int.)",
        liveSubject: "Y9-11 / G8-10 (Int.)",
        currentNormalizedCourseKey: "year_9_11_grade_8_10",
        targetNormalizedCourseKey: "year_9_11_grade_8_10",
        payrollCourseKeyMatches: true,
        status: "target_matched",
        detail: null,
      }],
    })).toEqual([
      {
        kind: "grade",
        id: "student-1",
        name: "Ada Li",
        status: "promoted_exact",
        expected: "Year 9 / Grade 8",
        current: "Year 9 / Grade 8",
        detail: null,
      },
      {
        kind: "course",
        id: "class-1",
        name: "",
        status: "target_matched",
        expected: "Y9-11 / G8-10 (Int.)",
        current: "Y9-11 / G8-10 (Int.)",
        detail: null,
      },
      {
        kind: "future_session",
        id: "session-1",
        name: "class-1",
        status: "target_matched",
        expected: "Y9-11 / G8-10 (Int.)",
        current: "Y9-11 / G8-10 (Int.)",
        currentNormalizedCourseKey: "year_9_11_grade_8_10",
        targetNormalizedCourseKey: "year_9_11_grade_8_10",
        payrollCourseKeyMatches: true,
        scheduledStartTime: "2026-07-01T03:00:00.000Z",
        detail: null,
      },
    ]);
  });
});

describe("StudentPromotionsWorkspace target-grade filter UI", () => {
  it("renders the target-grade control and full-run filtered count", () => {
    const html = renderToStaticMarkup(<StudentPromotionsWorkspace initialDetail={detail()} />);

    expect(html).toContain("Target grade");
    expect(html).toContain("Showing 3 of 3 grade actions");
  });

  it("renders grade rows beyond the old 500-row cutoff", () => {
    const gradeActions = Array.from({ length: 501 }, (_, index) =>
      gradeAction({
        id: `grade-${index + 1}`,
        wiseStudentId: `student-${index + 1}`,
        studentName: `Student ${index + 1}`,
      }),
    );

    const html = renderToStaticMarkup(<StudentPromotionsWorkspace initialDetail={detail({ gradeActions })} />);

    expect(html).toContain("Showing 501 of 501 grade actions");
    expect(html).toContain("Student 501");
  });

  it("shows freshness warnings for stale promotion runs", () => {
    const runDetail = detail({
      freshness: {
        sourceSnapshotId: "snapshot-old",
        sourceSnapshotGeneratedAt: new Date("2026-06-04T00:00:00.000Z"),
        sourceSnapshotStudentCount: 1054,
        activeCreditControlSnapshotId: "snapshot-new",
        activeCreditControlSnapshotGeneratedAt: new Date("2026-06-24T00:00:00.000Z"),
        activeCreditControlStudentCount: 1139,
        activeSnapshotIsNewer: true,
        runIsOlderThan24Hours: true,
      },
    });

    expect(freshnessWarningsForDetail(runDetail)).toHaveLength(2);
    const html = renderToStaticMarkup(<StudentPromotionsWorkspace initialDetail={runDetail} />);

    expect(html).toContain("The active snapshot is");
    expect(html).toContain("This audit is more than 24 hours old");
  });
});
