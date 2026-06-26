import { describe, expect, it } from "vitest";
import {
  buildStudentPromotionFutureSessionActionRows,
  buildStudentPromotionFutureSessionReadbackRows,
  buildStudentPromotionFreshness,
  buildStudentPromotionGradeReadbackRows,
  buildStudentPromotionPayRateImpactRows,
  classifyCourseReadback,
  classifyGradeApplyDecision,
  applyStudentPromotionFutureSessionActions,
  missingLiveAcceptedStudentIds,
  studentPromotionFutureSessionEligible,
  studentPromotionRunNeedsFreshAudit,
  type StudentPromotionRunDetail,
} from "../data";
import type { PayrollRateRuleRow } from "@/lib/payroll/rate-card";
import type { WiseSession, WiseTeacher } from "@/lib/wise/types";

type GradeAction = StudentPromotionRunDetail["gradeActions"][number];
type CourseAction = StudentPromotionRunDetail["courseActions"][number];
type FutureSessionAction = StudentPromotionRunDetail["futureSessionActions"][number];
type GraduationAction = StudentPromotionRunDetail["graduationActions"][number];

const now = new Date("2026-06-26T00:00:00.000Z");

function gradeAction(overrides: Partial<GradeAction> = {}): GradeAction {
  return {
    id: overrides.id ?? "grade-1",
    runId: overrides.runId ?? "run-1",
    wiseStudentId: overrides.wiseStudentId ?? "student-1",
    studentName: overrides.studentName ?? "Ada Li",
    studentKey: overrides.studentKey ?? "ada",
    currentGradeRaw: overrides.currentGradeRaw ?? "Year 8",
    parsedCurrentYear: overrides.parsedCurrentYear ?? 8,
    targetGrade: overrides.targetGrade === undefined ? "Year 9 / Grade 8" : overrides.targetGrade,
    actionType: overrides.actionType ?? "grade_increment_only",
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
    targetSubject: overrides.targetSubject === undefined ? "Y9-11 / G8-10 (Int.)" : overrides.targetSubject,
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
    studentKey: overrides.studentKey ?? "iris",
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

function wiseSession(overrides: Partial<WiseSession> = {}): WiseSession {
  return {
    _id: overrides._id ?? "session-1",
    scheduledStartTime: overrides.scheduledStartTime ?? "2026-07-01T03:00:00.000Z",
    scheduledEndTime: overrides.scheduledEndTime ?? "2026-07-01T04:00:00.000Z",
    userId: overrides.userId ?? "teacher-user-1",
    teacherId: overrides.teacherId ?? "teacher-doc-1",
    teacherName: overrides.teacherName ?? "Tutor One",
    studentCount: overrides.studentCount ?? 1,
    classId: overrides.classId ?? {
      _id: "class-1",
      subject: "Y2-8 / G1-7 (Int.)",
      classType: "REGULAR",
    },
    ...overrides,
  };
}

function rateRule(overrides: Partial<PayrollRateRuleRow>): PayrollRateRuleRow {
  return {
    id: overrides.id ?? "rule-1",
    versionId: overrides.versionId ?? "version-1",
    studentBand: overrides.studentBand ?? "1",
    curriculum: overrides.curriculum ?? "School Curriculum",
    course: overrides.course ?? "Y2-8 / G1-7 (Int.)",
    normalizedCourseKey: overrides.normalizedCourseKey ?? "year_2_8_grade_1_7",
    tierKey: overrides.tierKey ?? "BG1",
    sourceTierKey: overrides.sourceTierKey ?? "Tier 1",
    pricePerHour: overrides.pricePerHour ?? null,
    expectedRevenuePerHour: overrides.expectedRevenuePerHour ?? 1000,
    revenueShare: overrides.revenueShare ?? null,
    rawSourceRow: overrides.rawSourceRow ?? {},
    createdAt: overrides.createdAt ?? now,
  };
}

function wiseTeacher(overrides: Partial<WiseTeacher> = {}): WiseTeacher {
  return {
    _id: overrides._id ?? "teacher-doc-1",
    userId: overrides.userId ?? { _id: "teacher-user-1", name: "Tutor One" },
    name: overrides.name ?? "Tutor One",
    tags: overrides.tags ?? ["Tier 1"],
    ...overrides,
  };
}

function detail(overrides: Partial<StudentPromotionRunDetail> = {}): StudentPromotionRunDetail {
  const gradeActions = overrides.gradeActions ?? [gradeAction()];
  const courseActions = overrides.courseActions ?? [courseAction()];
  const futureSessionActions = overrides.futureSessionActions ?? [];
  const graduationActions = overrides.graduationActions ?? [];
  const payRateImpacts = overrides.payRateImpacts ?? [];
  return {
    run: {
      id: "run-1",
      targetDate: "2026-07-01",
      status: "draft",
      sourceSnapshotId: "snapshot-1",
      wiseAcceptedStudentCount: gradeActions.length,
      websiteSnapshotStudentCount: gradeActions.length,
      gradeOnlyCount: 1,
      year8CourseMoveCount: 0,
      year11CourseMoveCount: 0,
      skippedGradeCount: 0,
      pendingCourseActionCount: courseActions.length,
      skippedCourseActionCount: 0,
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

describe("student promotion data freshness", () => {
  it("marks a run stale when the active Credit Control snapshot is newer", () => {
    const freshness = buildStudentPromotionFreshness({
      runCreatedAt: new Date("2026-06-04T05:51:45.658Z"),
      sourceSnapshotId: "snapshot-old",
      sourceSnapshotGeneratedAt: new Date("2026-06-04T05:00:00.000Z"),
      sourceSnapshotStudentCount: 1054,
      activeSnapshotId: "snapshot-new",
      activeSnapshotGeneratedAt: new Date("2026-06-24T22:50:18.903Z"),
      activeSnapshotStudentCount: 1139,
      now: new Date("2026-06-26T00:00:00.000Z"),
    });

    expect(freshness).toMatchObject({
      sourceSnapshotId: "snapshot-old",
      sourceSnapshotStudentCount: 1054,
      activeCreditControlSnapshotId: "snapshot-new",
      activeCreditControlStudentCount: 1139,
      activeSnapshotIsNewer: true,
      runIsOlderThan24Hours: true,
    });
  });

  it("does not warn for a fresh run on the active snapshot", () => {
    const generatedAt = new Date("2026-06-26T00:00:00.000Z");
    const freshness = buildStudentPromotionFreshness({
      runCreatedAt: new Date("2026-06-26T00:05:00.000Z"),
      sourceSnapshotId: "snapshot-current",
      sourceSnapshotGeneratedAt: generatedAt,
      sourceSnapshotStudentCount: 1144,
      activeSnapshotId: "snapshot-current",
      activeSnapshotGeneratedAt: generatedAt,
      activeSnapshotStudentCount: 1144,
      now: new Date("2026-06-26T00:10:00.000Z"),
    });

    expect(freshness.activeSnapshotIsNewer).toBe(false);
    expect(freshness.runIsOlderThan24Hours).toBe(false);
  });

  it("flags stale runs as needing a fresh audit", () => {
    expect(studentPromotionRunNeedsFreshAudit(detail())).toBe(false);
    expect(studentPromotionRunNeedsFreshAudit(detail({
      freshness: {
        sourceSnapshotId: "snapshot-old",
        sourceSnapshotGeneratedAt: new Date("2026-06-04T00:00:00.000Z"),
        sourceSnapshotStudentCount: 1054,
        activeCreditControlSnapshotId: "snapshot-new",
        activeCreditControlSnapshotGeneratedAt: new Date("2026-06-24T00:00:00.000Z"),
        activeCreditControlStudentCount: 1139,
        activeSnapshotIsNewer: true,
        runIsOlderThan24Hours: false,
      },
    }))).toBe(true);
  });

  it("summarizes unresolved Year 13 graduation actions", () => {
    expect(detail({
      graduationActions: [
        graduationAction({ disposition: null, status: "pending_review" }),
        graduationAction({ id: "graduation-2", disposition: "inactive", status: "selected" }),
      ],
    }).summary).toMatchObject({
      pendingGraduationActions: 1,
      inactiveGraduationActions: 1,
    });
  });
});

describe("student promotion apply guardrails", () => {
  it("finds live accepted students missing from a verified run before apply", () => {
    const runDetail = detail({
      gradeActions: [
        gradeAction({ wiseStudentId: "student-1" }),
        gradeAction({ wiseStudentId: "student-2" }),
      ],
    });

    expect(missingLiveAcceptedStudentIds(runDetail, [
      { _id: "student-1" },
      { _id: "student-2" },
      { _id: "student-3" },
    ])).toEqual(["student-3"]);
  });

  it("treats manually pre-promoted students as idempotent and drifted grades as skipped", () => {
    const action = gradeAction({
      currentGradeRaw: "Year 8",
      parsedCurrentYear: 8,
      targetGrade: "Year 9 / Grade 8",
    });

    expect(classifyGradeApplyDecision(action, "Year 9 / Grade 8")).toEqual({ kind: "already_target" });
    expect(classifyGradeApplyDecision(action, "Year 10 / Grade 9")).toMatchObject({ kind: "grade_drift" });
    expect(classifyGradeApplyDecision(action, "Year 8")).toEqual({ kind: "write_required" });
  });
});

describe("student promotion future session guardrails", () => {
  it("refuses future-session Wise writes when the verification env flag is disabled", async () => {
    delete process.env.WISE_SESSION_SUBJECT_UPDATE_VERIFIED;

    await expect(applyStudentPromotionFutureSessionActions({
      runId: "run-1",
      actor: { email: "admin@example.com", name: "Admin" },
      db: {} as never,
      client: {} as never,
    })).rejects.toThrow("WISE_SESSION_SUBJECT_UPDATE_VERIFIED=true");
  });

  it("only treats mapped UK/US/IB school-curriculum July 1 Bangkok sessions as eligible", () => {
    const action = courseAction({
      currentSubject: "Y2-8 / G1-7 (Int.)",
      targetSubject: "Y9-11 / G8-10 (Int.)",
      status: "pending",
    });

    expect(studentPromotionFutureSessionEligible({
      courseAction: action,
      session: wiseSession({ scheduledStartTime: "2026-06-30T16:59:59.000Z" }),
    })).toBe(false);
    expect(studentPromotionFutureSessionEligible({
      courseAction: action,
      session: wiseSession({ scheduledStartTime: "2026-06-30T17:00:00.000Z" }),
    })).toBe(true);
    expect(studentPromotionFutureSessionEligible({
      courseAction: courseAction({
        currentSubject: "Grade 1-9",
        targetSubject: "Grade 10-12",
      }),
      session: wiseSession({ classId: { _id: "class-1", subject: "Grade 1-9" } }),
    })).toBe(false);
    expect(studentPromotionFutureSessionEligible({
      courseAction: action,
      session: wiseSession({ classId: { _id: "other-class", subject: "Y2-8 / G1-7 (Int.)" } }),
    })).toBe(false);
  });

  it("builds future-session actions only for eligible sessions and payroll promoted subjects", () => {
    const runDetail = detail({
      courseActions: [
        courseAction({
          id: "course-1",
          wiseClassId: "class-1",
          currentSubject: "(2-STU) Y2-8 / G1-7 (Int.)",
          targetSubject: "(2-STU) Y9-11 / G8-10 (Int.)",
        }),
        courseAction({
          id: "thai-course",
          wiseClassId: "thai-class",
          currentSubject: "Grade 1-9",
          targetSubject: "Grade 10-12",
        }),
      ],
    });

    const rows = buildStudentPromotionFutureSessionActionRows(runDetail, [
      wiseSession({
        _id: "session-needs-update",
        classId: { _id: "class-1", subject: "(2-STU) Y2-8 / G1-7 (Int.)" },
      }),
      wiseSession({
        _id: "session-already-target",
        classId: { _id: "class-1", subject: "(2-STU) Y9-11 / G8-10 (Int.)" },
      }),
      wiseSession({
        _id: "thai-session",
        classId: { _id: "thai-class", subject: "Grade 1-9" },
      }),
    ]);

    expect(rows.map((row) => [row.wiseSessionId, row.status, row.targetNormalizedCourseKey])).toEqual([
      ["session-needs-update", "pending", "year_9_11_grade_8_10"],
      ["session-already-target", "applied", "year_9_11_grade_8_10"],
    ]);
  });

  it("reports future-session readback buckets and payroll normalization state", () => {
    delete process.env.WISE_SESSION_SUBJECT_UPDATE_VERIFIED;
    const runDetail = detail({
      courseActions: [
        courseAction({
          id: "course-1",
          wiseClassId: "class-1",
          currentSubject: "Y2-8 / G1-7 (Int.)",
          targetSubject: "Y9-11 / G8-10 (Int.)",
        }),
      ],
      futureSessionActions: [
        futureSessionAction({
          wiseSessionId: "failed-session",
          status: "failed",
          errorMessage: "Wise rejected update",
        }),
      ],
    });

    const rows = buildStudentPromotionFutureSessionReadbackRows(runDetail, [
      wiseSession({
        _id: "matched",
        classId: { _id: "class-1", subject: "Y9-11 / G8-10 (Int.)" },
      }),
      wiseSession({
        _id: "manual",
        classId: { _id: "class-1", subject: "Y2-8 / G1-7 (Int.)" },
      }),
      wiseSession({
        _id: "drift",
        classId: { _id: "class-1", subject: "SAT" },
      }),
      wiseSession({
        _id: "failed-session",
        classId: { _id: "class-1", subject: "Y2-8 / G1-7 (Int.)" },
      }),
    ]);

    expect(Object.fromEntries(rows.map((row) => [row.wiseSessionId, row.status]))).toMatchObject({
      matched: "target_matched",
      manual: "manual_required",
      drift: "subject_drift",
      "failed-session": "failed",
    });
    expect(rows.find((row) => row.wiseSessionId === "matched")).toMatchObject({
      currentNormalizedCourseKey: "year_9_11_grade_8_10",
      targetNormalizedCourseKey: "year_9_11_grade_8_10",
      payrollCourseKeyMatches: true,
    });
  });

  it("groups pay-rate impacts by teacher, class, student band, and course pair", () => {
    const runDetail = detail({
      gradeActions: [
        gradeAction({ wiseStudentId: "student-1", studentName: "Ada Li" }),
        gradeAction({ wiseStudentId: "student-2", studentName: "Ben Li" }),
      ],
      courseActions: [
        courseAction({
          id: "course-y12",
          wiseClassId: "class-y12",
          currentSubject: "Y9-11 / G8-10 (Int.)",
          targetSubject: "Y12-13 / G11-12 (Int.)",
          transitionType: "year11_to_year12",
          studentIds: ["student-1", "student-2"],
          qualifyingStudentIds: ["student-1", "student-2"],
        }),
      ],
    });

    const rows = buildStudentPromotionPayRateImpactRows({
      detail: runDetail,
      liveSessions: [
        wiseSession({ _id: "session-1", classId: { _id: "class-y12", subject: "Y9-11 / G8-10 (Int.)" }, studentCount: 2 }),
        wiseSession({ _id: "session-2", classId: { _id: "class-y12", subject: "Y9-11 / G8-10 (Int.)" }, studentCount: 2 }),
      ],
      teachers: [wiseTeacher()],
      activeRateCard: {
        hasActiveRateCard: true,
        rules: [
          rateRule({
            id: "before",
            studentBand: "2",
            normalizedCourseKey: "year_9_11_grade_8_10",
            expectedRevenuePerHour: 1100,
          }),
          rateRule({
            id: "after",
            studentBand: "2",
            normalizedCourseKey: "year_12_13_grade_11_12",
            expectedRevenuePerHour: 1400,
          }),
        ],
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teacherName: "Tutor One",
      normalizedTier: "BG1",
      studentBand: "2",
      currentNormalizedCourseKey: "year_9_11_grade_8_10",
      targetNormalizedCourseKey: "year_12_13_grade_11_12",
      beforeExpectedHourlyRate: 1100,
      afterExpectedHourlyRate: 1400,
      rateDelta: 300,
      futureSessionCount: 2,
      affectedStudentNames: ["Ada Li", "Ben Li"],
      reviewStatus: "pending_review",
      blockerReason: null,
    });
  });

  it("blocks pay-rate verification when live teacher tags do not include a tier", () => {
    const runDetail = detail({
      courseActions: [
        courseAction({
          wiseClassId: "class-1",
          currentSubject: "Y2-8 / G1-7 (Int.)",
          targetSubject: "Y9-11 / G8-10 (Int.)",
        }),
      ],
    });

    const rows = buildStudentPromotionPayRateImpactRows({
      detail: runDetail,
      liveSessions: [wiseSession({ classId: { _id: "class-1", subject: "Y2-8 / G1-7 (Int.)" } })],
      teachers: [wiseTeacher({ tags: [] })],
      activeRateCard: {
        hasActiveRateCard: true,
        rules: [],
      },
    });

    expect(rows[0]).toMatchObject({
      reviewStatus: "blocked",
      blockerReason: "missing_teacher_tier",
      normalizedTier: "Unassigned",
    });
  });
});

describe("student promotion readback classification", () => {
  it("classifies promoted, equivalent, missing, skipped, wrong, unparseable, and failed grade rows", () => {
    const runDetail = detail({
      gradeActions: [
        gradeAction({ wiseStudentId: "exact", targetGrade: "Year 9 / Grade 8", parsedCurrentYear: 8 }),
        gradeAction({ wiseStudentId: "equivalent", targetGrade: "Year 9 / Grade 8", parsedCurrentYear: 8 }),
        gradeAction({
          wiseStudentId: "skipped",
          targetGrade: null,
          parsedCurrentYear: null,
          status: "skipped",
          skipReason: "missing_grade_review",
        }),
        gradeAction({ wiseStudentId: "wrong", targetGrade: "Year 9 / Grade 8", parsedCurrentYear: 8 }),
        gradeAction({ wiseStudentId: "unparseable", targetGrade: "Year 9 / Grade 8", parsedCurrentYear: 8 }),
        gradeAction({ wiseStudentId: "failed", targetGrade: "Year 9 / Grade 8", parsedCurrentYear: 8 }),
      ],
    });

    const rows = buildStudentPromotionGradeReadbackRows(
      runDetail,
      [
        { _id: "exact", name: "Exact" },
        { _id: "equivalent", name: "Equivalent" },
        { _id: "missing", name: "Missing" },
        { _id: "skipped", name: "Skipped" },
        { _id: "wrong", name: "Wrong" },
        { _id: "unparseable", name: "Unparseable" },
        { _id: "failed", name: "Failed" },
      ],
      [
        { wiseStudentId: "exact", gradeRaw: "Year 9 / Grade 8" },
        { wiseStudentId: "equivalent", gradeRaw: "Grade 8" },
        { wiseStudentId: "missing", gradeRaw: "Year 9 / Grade 8" },
        { wiseStudentId: "skipped", gradeRaw: "" },
        { wiseStudentId: "wrong", gradeRaw: "Year 8" },
        { wiseStudentId: "unparseable", gradeRaw: "Uni" },
        { wiseStudentId: "failed", gradeRaw: "", errorMessage: "Wise timeout" },
      ],
    );

    expect(Object.fromEntries(rows.map((row) => [row.wiseStudentId, row.status]))).toEqual({
      exact: "promoted_exact",
      equivalent: "promoted_equivalent",
      missing: "missing_from_run",
      skipped: "skipped_needs_review",
      wrong: "wrong_grade",
      unparseable: "unparseable_grade",
      failed: "fetch_failed",
    });
  });

  it("classifies course target matches, subject drift, roster drift, skipped rows, and fetch failures", () => {
    expect(classifyCourseReadback(courseAction(), {
      liveSubject: "Y9-11 / G8-10 (Int.)",
      liveStudentIds: ["student-1"],
    }).status).toBe("target_matched");
    expect(classifyCourseReadback(courseAction(), {
      liveSubject: "Y10-11 / G9-10 (Int.)",
      liveStudentIds: ["student-1"],
    }).status).toBe("subject_drift");
    expect(classifyCourseReadback(courseAction(), {
      liveSubject: "Y9-11 / G8-10 (Int.)",
      liveStudentIds: ["student-2"],
    }).status).toBe("roster_drift");
    expect(classifyCourseReadback(courseAction({ targetSubject: null }), {}).status).toBe("skipped_needs_review");
    expect(classifyCourseReadback(courseAction(), { errorMessage: "Wise failed" }).status).toBe("fetch_failed");
  });
});
